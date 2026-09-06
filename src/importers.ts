// Importers for ChatGPT, Claude, Cursor, generic files and structured markdown.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { createMemory, Layer, MemoryEntry } from './memory.js';
import { initStore, loadAllEntries, writeEntry } from './store.js';
import { textOverlap } from './search.js';
import { getGlobalRoot, initGlobal } from './shared.js';
import { remember, archiveRaw, isPrivateScope, type Context } from './api.js';
import { openHippoDb, closeHippoDb } from './db.js';

export interface ImportResult {
  total: number;     // entries found in source
  imported: number;  // actually imported (after dedup)
  skipped: number;   // skipped as duplicates or too short
  /** Rows archived this run (changed + source-deleted); in dryRun, the would-be count. */
  archived?: number;
  entries: MemoryEntry[];
}

export interface ImportOptions {
  dryRun?: boolean;
  global?: boolean;
  extraTags?: string[];
  hippoRoot: string;
  /** Tenant scope for the dedup read (ignored when global=true); undefined preserves pre-1.12.1 host-wide dedup. */
  tenantId?: string;
  /** Vault import only: identity key for the vault:<name>:<relpath> artifactRef and the destructive deletion-sync; required (importVault throws if unset) since a basename default risks two vaults colliding (see ARCHITECTURE.md). */
  name?: string;
  /** Vault import only: scope stamped on every imported note; defaults to null (unscoped). */
  scope?: string;
}

/** Dedup threshold: textOverlap > 0.7 against any existing memory skips a chunk as duplicate. */
export function importEntries(
  chunks: string[],
  source: string,
  tags: string[],
  options: ImportOptions
): ImportResult {
  const targetRoot = options.global ? getGlobalRoot() : options.hippoRoot;

  if (options.global) {
    initGlobal();
  }

  const existing = loadAllEntries(
    targetRoot,
    options.global ? undefined : options.tenantId,
  );
  const allTags = [...new Set([...tags, ...(options.extraTags ?? [])])];

  let total = 0;
  let imported = 0;
  let skipped = 0;
  const entries: MemoryEntry[] = [];

  for (const raw of chunks) {
    const trimmed = raw.trim();
    if (trimmed.length > 1000) {
      console.error(`Warning: imported memory truncated from ${trimmed.length} to 1000 chars`);
    }
    const chunk = trimmed.slice(0, 1000);

    if (!chunk || chunk.length < 10) {
      skipped++;
      continue;
    }

    total++;

    let isDuplicate = false;
    for (const existing_entry of existing) {
      if (textOverlap(chunk, existing_entry.content) > 0.7) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      skipped++;
      continue;
    }

    // Chunk imports default to kind='distilled' (curated pastes, unlike Slack's raw ingestion; see MEMORY_ENVELOPE.md).
    // tenantId must mirror the dedup-read scope: global writes go host-wide; scoped reads write to the same tenant.
    const entry = createMemory(chunk, {
      layer: Layer.Episodic,
      tags: allTags,
      source,
      confidence: 'observed',
      tenantId: options.global ? undefined : options.tenantId,
    });

    entries.push(entry);

    if (!options.dryRun) {
      writeEntry(targetRoot, entry);
      // Add to existing so subsequent chunks dedup against freshly imported ones
      existing.push(entry);
    }

    imported++;
  }

  return { total, imported, skipped, entries };
}

// ---------------------------------------------------------------------------
// ChatGPT importer
// ---------------------------------------------------------------------------

/** Parses ChatGPT export format: JSON array of strings/objects ({content|text}), {memories:[...]}, or plain text one-per-line. */
function parseChatGPTFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.memories)) {
        return parsed.memories
          .map((m: unknown) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const obj = m as Record<string, unknown>;
              return String(obj['content'] ?? obj['text'] ?? '');
            }
            return '';
          })
          .filter(Boolean);
      }

      if (Array.isArray(parsed)) {
        return parsed
          .map((m: unknown) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const obj = m as Record<string, unknown>;
              return String(obj['content'] ?? obj['text'] ?? '');
            }
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to plain text
    }
  }

  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function importChatGPT(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseChatGPTFile(filePath);
  return importEntries(chunks, 'import:chatgpt', ['imported', 'chatgpt'], options);
}

const HIPPO_START = '<!-- hippo:start -->';
const HIPPO_END = '<!-- hippo:end -->';

function stripHippoBlock(content: string): string {
  const startIdx = content.indexOf(HIPPO_START);
  const endIdx = content.indexOf(HIPPO_END);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + HIPPO_END.length);
}

function splitMarkdown(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#{1,6}\s+/.test(trimmed)) {
      if (current.trim()) chunks.push(current.trim());
      current = trimmed;
      continue;
    }

    // Bullet: each bullet is its own chunk; flush any pending text first.
    if (/^[-*+]\s+/.test(trimmed)) {
      if (current.trim() && !/^[-*+]\s+/.test(current.split('\n')[0])) {
        chunks.push(current.trim());
        current = '';
      }
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^[-*+]\s+/, '').trim();
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^\d+\.\s+/, '').trim();
      continue;
    }

    if (!trimmed) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      continue;
    }

    current = current ? current + ' ' + trimmed : trimmed;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function parseClaudeFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');

  if (filePath.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) {
        return parsed
          .map((m: unknown) => {
            if (typeof m === 'string') return m;
            if (m && typeof m === 'object') {
              const obj = m as Record<string, unknown>;
              return String(obj['content'] ?? obj['text'] ?? '');
            }
            return '';
          })
          .filter(Boolean);
      }
    } catch {
      // Fall through to markdown
    }
  }

  const cleaned = stripHippoBlock(raw);
  return splitMarkdown(cleaned);
}

export function importClaude(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseClaudeFile(filePath);
  return importEntries(chunks, 'import:claude', ['imported', 'claude'], options);
}

/** Cursor rules chunking priority: numbered items > bullets > double newlines. */
function parseCursorFile(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comment-only lines that are empty after stripping #
    if (!trimmed || trimmed === '#') {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^\d+\.\s+/, '').trim();
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^[-*]\s+/, '').trim();
      continue;
    }

    current = current ? current + ' ' + trimmed : trimmed;
  }

  if (current.trim()) chunks.push(current.trim());

  // Also split on double newlines within chunks if they somehow ended up there
  return chunks.flatMap((c) => {
    const parts = c.split(/\n{2,}/);
    return parts.map((p) => p.trim()).filter(Boolean);
  });
}

export function importCursor(filePath: string, options: ImportOptions): ImportResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const chunks = parseCursorFile(raw);
  return importEntries(chunks, 'import:cursor', ['imported', 'cursor'], options);
}

/** Markdown files split on headings/bullets; plain text splits on double newlines, falling back to one-per-line. */
function parseGenericFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx');

  if (isMarkdown) {
    return splitMarkdown(raw);
  }

  const byParagraph = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (byParagraph.length > 1) return byParagraph;

  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function importGenericFile(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseGenericFile(filePath);
  return importEntries(chunks, 'import:file', ['imported'], options);
}

/** Slugify a heading for use as a tag, e.g. "Data Pipeline & Cache" -> "data-pipeline-cache". */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

/** Each heading starts a section; bullets/numbered items under it become individual memories tagged with the section slug. */
function parseStructuredMarkdown(raw: string): Array<{ content: string; sectionSlug: string }> {
  const results: Array<{ content: string; sectionSlug: string }> = [];
  const lines = raw.split('\n');

  let currentSection = '';
  let currentSlug = '';
  let pendingText = '';

  function flush(): void {
    if (!pendingText.trim()) return;
    results.push({ content: pendingText.trim(), sectionSlug: currentSlug });
    pendingText = '';
  }

  for (const line of lines) {
    const trimmed = line.trim();

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flush();
      currentSection = headingMatch[2].trim();
      currentSlug = slugify(currentSection);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flush();
      const itemText = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      pendingText = itemText;
      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    pendingText = pendingText ? pendingText + ' ' + trimmed : trimmed;
  }

  flush();
  return results.filter((r) => r.content.length > 0);
}

export function importMarkdown(filePath: string, options: ImportOptions): ImportResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseStructuredMarkdown(raw);

  // Group by section slug so importEntries can be called once per slug with that slug's tags.
  const bySlug = new Map<string, string[]>();
  for (const { content, sectionSlug } of parsed) {
    const list = bySlug.get(sectionSlug) ?? [];
    list.push(content);
    bySlug.set(sectionSlug, list);
  }

  let totalResult: ImportResult = { total: 0, imported: 0, skipped: 0, entries: [] };

  for (const [slug, chunks] of bySlug.entries()) {
    const sectionTags = slug ? ['imported', slug] : ['imported'];
    const result = importEntries(chunks, 'import:markdown', sectionTags, options);
    totalResult = {
      total: totalResult.total + result.total,
      imported: totalResult.imported + result.imported,
      skipped: totalResult.skipped + result.skipped,
      entries: [...totalResult.entries, ...result.entries],
    };
  }

  return totalResult;
}

// K1 vault importer: mirrors the connector pattern (kind='raw', append-only; never supersede — see ARCHITECTURE.md).

/** Escapes LIKE wildcards (mirrors project-briefs.ts/store.ts's local copies) so a %/_/\ in the vault name can't over-match the loader prefix. */
function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
}

/** Minimal frontmatter split (no YAML dep): returns {fm, body}; fm is empty when no well-formed --- block is present. */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  // Must start with `---` on its own line. Accept CRLF or LF.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);
  const fm: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '') {
      // YAML block-list (`key:` + indented `- item` lines, common in Obsidian/Dendron): collect into a comma-joined value for frontmatterList.
      const items: string[] = [];
      let j = i + 1;
      let item: RegExpMatchArray | null;
      while (j < lines.length && (item = lines[j].match(/^\s+-\s+(.+?)\s*$/)) !== null) {
        items.push(item[1].replace(/^['"]|['"]$/g, '').trim());
        j++;
      }
      if (items.length) {
        val = items.join(', ');
        i = j - 1;
      }
    }
    fm[kv[1]] = val;
  }
  return { fm, body };
}

/** Normalizes a frontmatter field (YAML flow list, comma-separated scalar, or single token) into a string[]; quotes/brackets stripped. */
function frontmatterList(value: string | undefined): string[] {
  if (!value) return [];
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** Parses [[target]] / [[target|alias]] wikilinks (alias dropped, deduped); embeds (![[…]]) are intentionally matched too since ! isn't part of the [[…]] capture. */
function parseWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const inner = match[1];
    const target = (inner.split('|')[0] ?? '').trim();
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Recursively collects *.md paths (root-relative, forward-slash); skips dot-dirs and the store path to avoid self-import (see ARCHITECTURE.md — root-IS-store is handled one level up in importVault, not here). */
function collectMarkdownFiles(root: string, hippoRoot: string): string[] {
  const out: string[] = [];
  // Canonicalize via realpath (not path.resolve) so an aliased HIPPO_HOME (junction/case-variant) is still recognized and skipped (see ARCHITECTURE.md).
  const resolvedHippoRoot = realpathOrResolve(hippoRoot);
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip dot-dirs (incl. the default .hippo store) and the canonicalized store path (covers a HIPPO_HOME outside .hippo).
        if (ent.name.startsWith('.')) continue;
        if (realpathOrResolve(abs) === resolvedHippoRoot) continue;
        walk(abs);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  out.sort();
  return out;
}

/** Canonicalizes via OS realpath (dereferences symlinks/junctions, normalizes Windows case) so an aliased store path is still recognized as self-store; falls back to path.resolve for a not-yet-existing path (see ARCHITECTURE.md). */
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

interface VaultRow {
  id: string;
  artifact_ref: string;
  tags_json: string;
  scope: string | null;
}

/** Imports a markdown vault folder as kind='raw' memories. NOT re-entrant: idempotency rests on the in-memory Map loaded once, so concurrent runs over the same vault can double-insert. */
export function importVault(folderPath: string, options: ImportOptions): ImportResult {
  const hippoRoot = options.hippoRoot;
  const tenantId = options.tenantId ?? 'default';
  // Explicit name required: a basename default let two same-basename vaults collide and archive each other's rows (see ARCHITECTURE.md).
  const vaultName = options.name?.trim();
  if (!vaultName) {
    throw new Error(
      'importVault requires an explicit vault name (options.name): it is the identity key for source-deletion sync and must not be inferred from the folder basename.',
    );
  }
  if (vaultName.includes(':')) {
    // ':' is the artifactRef delimiter; a name containing it could let a prefix scan over-match and archive another vault's rows.
    throw new Error(`vault name must not contain ':' (artifactRef delimiter): ${vaultName}`);
  }
  const scope = options.scope ?? null;
  // Privacy footgun: a bare 'private' segment isn't recognized by isPrivateScope's <source>:private:* rule and would leak; reject rather than silently expose (see ARCHITECTURE.md).
  if (scope !== null && scope.split(':').includes('private') && !isPrivateScope(scope)) {
    throw new Error(
      `vault scope '${scope}' is not recognized as private by recall (only '<source>:private:*' scopes are default-denied). Use a source-prefixed scope such as 'vault:private:${vaultName}'.`,
    );
  }
  const extraTags = options.extraTags ?? [];
  const dryRun = options.dryRun ?? false;
  if (options.global) {
    // Raw-archive is tenant-local; global mode would misfile rows, so reject here too (CLI already rejects --global).
    throw new Error('importVault does not support global mode (raw rows are tenant-local).');
  }

  // Self-store guard MUST run before the existing-rows load / deletion-sync below: an empty scan here is indistinguishable from "everything deleted", and archiveRaw's redaction makes that IRREVERSIBLE (see ARCHITECTURE.md).
  const resolvedStore = realpathOrResolve(hippoRoot);
  const resolvedFolder = realpathOrResolve(folderPath);
  if (resolvedFolder === resolvedStore || resolvedFolder.startsWith(resolvedStore + path.sep)) {
    return { total: 0, imported: 0, skipped: 0, archived: 0, entries: [] };
  }

  const ctx: Context = {
    hippoRoot,
    tenantId,
    // Process-local actor (CLI/SDK path, not bearer-authed); threaded into audit by archiveRaw/remember.
    actor: { subject: 'connector:vault', role: 'admin' },
  };

  // Load once: the same Map serves per-file idempotency AND the deletion diff (LIKE-escaped so %/_ in the name can't over-match).
  initStore(hippoRoot);
  // artifactRef -> ALL live raw rows (>1 only after a concurrent double-insert); every bucket must be archived on change/deletion, not just the last-scanned row.
  const existing = new Map<string, VaultRow[]>();
  {
    const db = openHippoDb(hippoRoot);
    try {
      const likeParam = `vault:${escapeLike(vaultName)}:%`;
      const rows = db
        .prepare(
          `SELECT id, artifact_ref, tags_json, scope FROM memories
             WHERE artifact_ref LIKE ? ESCAPE '\\' AND tenant_id = ? AND kind = 'raw'`,
        )
        .all(likeParam, tenantId) as VaultRow[];
      // SQLite LIKE is ASCII case-insensitive (vault 'A' also matches 'vault:a:%'); re-filter to the exact-case prefix so deletion-sync can't cross vaults.
      const exactPrefix = `vault:${vaultName}:`;
      for (const row of rows) {
        if (row.artifact_ref && row.artifact_ref.startsWith(exactPrefix)) {
          const bucket = existing.get(row.artifact_ref);
          if (bucket) bucket.push(row);
          else existing.set(row.artifact_ref, [row]);
        }
      }
    } finally {
      closeHippoDb(db);
    }
  }

  const relpaths = collectMarkdownFiles(folderPath, hippoRoot);
  const seen = new Set<string>();

  let total = 0;
  let imported = 0;
  let skipped = 0;
  let archived = 0;
  const entries: MemoryEntry[] = [];

  for (const relpath of relpaths) {
    total++;
    const artifactRef = `vault:${vaultName}:${relpath}`;
    seen.add(artifactRef);

    // Hash is over raw file bytes (deterministic, no Date/random) so idempotency covers frontmatter edits the same as body edits.
    let rawFileContent: string;
    try {
      rawFileContent = fs.readFileSync(path.join(folderPath, relpath), 'utf8');
    } catch {
      // TOCTOU or transient IO error: skip this file rather than abort the whole import; an idempotent re-run picks it up.
      skipped++;
      continue;
    }
    const hash = createHash('sha256').update(rawFileContent).digest('hex');
    const hashTag = `content-hash:${hash}`;

    // Idempotency check happens after the full tag envelope is built below, so it compares the complete set, not a subset.
    const priors = existing.get(artifactRef) ?? [];

    const { fm, body } = parseFrontmatter(rawFileContent);

    // Empty/frontmatter-only body = content deleted at source: archive prior rows (must not stay live+searchable) then skip the write; stays in `seen` so deletion-sync doesn't double-process it.
    if (body.trim().length < 3) {
      for (const p of priors) {
        archived++; // count even in dryRun so the preview reflects the removal
        if (!dryRun) archiveRaw(ctx, p.id, `emptied:${artifactRef}`);
      }
      skipped++;
      continue;
    }

    // Build the full tag envelope before the idempotency check; de-duped since createMemory stores tags verbatim.
    const frontmatterTags = [
      ...frontmatterList(fm['tags']),
      ...frontmatterList(fm['aliases']).map((a) => `alias:${a}`),
    ];
    const wikilinkTags = parseWikilinks(body).map((t) => `wikilink-candidate:${t}`);
    const tags = Array.from(
      new Set([
        'source:vault',
        `vault:${vaultName}`,
        hashTag,
        ...frontmatterTags,
        ...wikilinkTags,
        ...extraTags,
      ]),
    );

    // Unchanged iff every live row's tag set AND scope exactly match (full-set comparison catches content/frontmatter/wikilink/tag changes that piecemeal checks used to miss).
    const wantTags = new Set(tags);
    const envelopeUnchanged =
      priors.length > 0 &&
      priors.every((p) => {
        if ((p.scope ?? null) !== scope) return false;
        const priorTags = parseJsonArrayLoose(p.tags_json);
        return priorTags.length === wantTags.size && priorTags.every((t) => wantTags.has(t));
      });
    if (envelopeUnchanged) {
      skipped++;
      continue;
    }

    // Changed: archive every old row (never supersede — that would yield kind='distilled'); archiveRaw commits before remember() runs, so a crash between them self-heals on next import.
    for (const p of priors) {
      archived++; // count the would-be archive even in dryRun (true preview)
      if (!dryRun) archiveRaw(ctx, p.id, `changed:${artifactRef}`);
    }

    // echo mirrors what remember() will write, purely for ImportResult; its id is reconciled to the real row id below.
    const echo = createMemory(body, {
      kind: 'raw',
      tags,
      scope,
      owner: 'agent:vault-import',
      artifact_ref: artifactRef,
      tenantId,
    });
    // dryRun preview: count what WOULD import, but make no writes.
    if (!dryRun) {
      const result = remember(ctx, {
        content: body,
        kind: 'raw',
        artifactRef,
        owner: 'agent:vault-import',
        scope: scope ?? undefined,
        tags,
      });
      echo.id = result.id;
    }
    entries.push(echo);
    imported++;
  }

  // Deletion-sync: any artifactRef not seen this run vanished from source — archive it (per-file archiveRaw, no outer SAVEPOINT needed here).
  for (const [artifactRef, rows] of existing) {
    if (seen.has(artifactRef)) continue;
    for (const row of rows) {
      archived++; // count even in dryRun so the preview reflects destructive deletes
      if (!dryRun) archiveRaw(ctx, row.id, `source_deleted:${artifactRef}`);
    }
  }

  return { total, imported, skipped, archived, entries };
}

/** Local tolerant JSON-array parse for tags_json; mirrors store.ts's unexported parseJsonArray contract (returns [] on null/garbage). */
function parseJsonArrayLoose(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
