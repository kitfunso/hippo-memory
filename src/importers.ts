/**
 * Memory importers for Hippo.
 * Imports memories from ChatGPT, Claude, Cursor, generic files, and structured markdown.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { createMemory, Layer, MemoryEntry } from './memory.js';
import { initStore, loadAllEntries, writeEntry } from './store.js';
import { textOverlap } from './search.js';
import { getGlobalRoot, initGlobal } from './shared.js';
import { remember, archiveRaw, type Context } from './api.js';
import { openHippoDb, closeHippoDb } from './db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  total: number;     // entries found in source
  imported: number;  // actually imported (after dedup)
  skipped: number;   // skipped as duplicates or too short
  /** K1 vault import: rows archived this run (changed + source-deleted). In a
   *  dryRun this is the would-be count (a true deletion-sync preview). */
  archived?: number;
  entries: MemoryEntry[];
}

export interface ImportOptions {
  dryRun?: boolean;
  global?: boolean;
  extraTags?: string[];
  hippoRoot: string;
  /**
   * L9: tenant scope for the dedup read. When provided AND `global` is
   * false, the dedup check only considers this tenant's existing entries.
   * Ignored when `global: true` (global writes are host-wide by definition).
   * Undefined preserves pre-1.12.1 host-wide dedup behaviour.
   */
  tenantId?: string;
  /**
   * K1 vault import only. Logical vault name used in the `vault:<name>` tag and
   * the `artifactRef='vault:<name>:<relpath>'` key. Defaults to
   * `basename(folderPath)` when unset. Operator-supplied, so the loader query
   * LIKE-escapes it (see `escapeLike` below).
   */
  name?: string;
  /**
   * K1 vault import only. Memory scope stamped on every imported note. Defaults
   * to null (unscoped) when unset.
   */
  scope?: string;
}

// ---------------------------------------------------------------------------
// Shared core: dedup + write
// ---------------------------------------------------------------------------

/**
 * Given an array of raw text chunks, deduplicate against existing memories,
 * create MemoryEntry objects, write them (unless dry-run), and return a result.
 */
export function importEntries(
  chunks: string[],
  source: string,
  tags: string[],
  options: ImportOptions
): ImportResult {
  const targetRoot = options.global ? getGlobalRoot() : options.hippoRoot;

  // Ensure store is ready
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

    // Skip empty or too-short chunks
    if (!chunk || chunk.length < 10) {
      skipped++;
      continue;
    }

    total++;

    // Dedup check: textOverlap > 0.7 with any existing memory = skip
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

    // A3: kind defaults to 'distilled'. ChatGPT/Claude/Cursor exports are curated
    // user pastes, not raw transcripts from a system of record, so distilled is
    // correct here. E1.3 (Slack ingestion) shipped 2026-04-29 in src/connectors/slack/
    // and sets kind: 'raw' + routes deletions through archiveRawMemory() — these
    // importers stay 'distilled' per the original reasoning. See MEMORY_ENVELOPE.md.
    // L9: the dedup read above is scoped by options.tenantId — the WRITE
    // must match, or scoped-dedup-passes-then-default-tenant-write breaks
    // the per-tenant contract. Mirror the dedup-read guard: global=true
    // → host-wide write to global store (tenantId irrelevant, createMemory
    // defaults to 'default'). global=false → write to the same tenant as
    // the dedup read.
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

/**
 * Parse ChatGPT memory export file.
 * Supports:
 *   - JSON array of strings: ["memory 1", "memory 2"]
 *   - JSON array of objects: [{"content": "...", "created": "..."}]
 *   - ChatGPT export format: {"memories": [{"content": "...", "created_at": "..."}]}
 *   - Plain text: one memory per line
 */
function parseChatGPTFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim();

  // Try JSON first
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);

      // {"memories": [...]} - ChatGPT export format
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

      // Array format
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

  // Plain text: one memory per line
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function importChatGPT(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseChatGPTFile(filePath);
  return importEntries(chunks, 'import:chatgpt', ['imported', 'chatgpt'], options);
}

// ---------------------------------------------------------------------------
// Claude importer
// ---------------------------------------------------------------------------

const HIPPO_START = '<!-- hippo:start -->';
const HIPPO_END = '<!-- hippo:end -->';

/**
 * Strip the hippo hook block from markdown content.
 */
function stripHippoBlock(content: string): string {
  const startIdx = content.indexOf(HIPPO_START);
  const endIdx = content.indexOf(HIPPO_END);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + HIPPO_END.length);
}

/**
 * Split markdown into meaningful chunks (headings + bullet points).
 */
function splitMarkdown(content: string): string[] {
  const chunks: string[] = [];
  const lines = content.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Heading: start a new chunk
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (current.trim()) chunks.push(current.trim());
      current = trimmed;
      continue;
    }

    // Bullet point: each bullet is its own chunk (flush previous if not a bullet context)
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

    // Numbered list item
    if (/^\d+\.\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^\d+\.\s+/, '').trim();
      continue;
    }

    // Empty line
    if (!trimmed) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      continue;
    }

    // Regular line: append to current
    current = current ? current + ' ' + trimmed : trimmed;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

/**
 * Parse CLAUDE.md or Claude memory.json.
 */
function parseClaudeFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');

  // JSON memory file
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

  // Markdown file: strip hippo block and split
  const cleaned = stripHippoBlock(raw);
  return splitMarkdown(cleaned);
}

export function importClaude(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseClaudeFile(filePath);
  return importEntries(chunks, 'import:claude', ['imported', 'claude'], options);
}

// ---------------------------------------------------------------------------
// Cursor importer
// ---------------------------------------------------------------------------

/**
 * Split cursor rules file into chunks.
 * Priority: numbered items, then bullet points, then double newlines.
 */
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

    // Numbered item: 1. 2. 3.
    if (/^\d+\.\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^\d+\.\s+/, '').trim();
      continue;
    }

    // Bullet: - or *
    if (/^[-*]\s+/.test(trimmed)) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      current = trimmed.replace(/^[-*]\s+/, '').trim();
      continue;
    }

    // Regular line
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

// ---------------------------------------------------------------------------
// Generic file importer
// ---------------------------------------------------------------------------

/**
 * Split a generic file into chunks.
 * Markdown: split on headings and bullet points.
 * Plain text: split on double newlines or one-per-line.
 */
function parseGenericFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.mdx');

  if (isMarkdown) {
    return splitMarkdown(raw);
  }

  // Plain text: try double newlines first
  const byParagraph = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (byParagraph.length > 1) return byParagraph;

  // Fall back to one-per-line
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function importGenericFile(filePath: string, options: ImportOptions): ImportResult {
  const chunks = parseGenericFile(filePath);
  return importEntries(chunks, 'import:file', ['imported'], options);
}

// ---------------------------------------------------------------------------
// Structured markdown importer (MEMORY.md / AGENTS.md format)
// ---------------------------------------------------------------------------

/**
 * Slugify a heading for use as a tag.
 * "Data Pipeline & Cache" -> "data-pipeline-cache"
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

/**
 * Parse structured markdown into {content, sectionSlug} pairs.
 * Each heading starts a new section. Bullet points / numbered items under
 * the heading become individual memories tagged with the section slug.
 */
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

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flush();
      currentSection = headingMatch[2].trim();
      currentSlug = slugify(currentSection);
      continue;
    }

    // Bullet or numbered item: flush previous, start new
    if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flush();
      const itemText = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      pendingText = itemText;
      continue;
    }

    // Empty line: flush current pending
    if (!trimmed) {
      flush();
      continue;
    }

    // Continuation of current item
    pendingText = pendingText ? pendingText + ' ' + trimmed : trimmed;
  }

  flush();
  return results.filter((r) => r.content.length > 0);
}

export function importMarkdown(filePath: string, options: ImportOptions): ImportResult {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseStructuredMarkdown(raw);

  // Group by section slug so we can pass per-chunk tags
  // We call importEntries per unique slug to get the right tags per section
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

// ---------------------------------------------------------------------------
// K1 vault importer (markdown-vault FOLDER → kind='raw' memories)
//
// MIRRORS THE CONNECTOR PATTERN (src/connectors/slack|github), NOT the
// single-file importers above. Each note becomes a single kind='raw' row with
// provenance in TAGS (`source:vault` + `vault:<name>`), an artifactRef cursor
// key, and a content-hash tag. Changes APPEND a new raw row after archiveRaw of
// the old one; deletions archiveRaw the orphaned rows. We NEVER `supersede` a
// raw row (supersede yields kind='distilled', losing raw-append-only protection
// and escaping the kind='raw' deletion rescan) — all raw deletions route through
// `archiveRaw` (the only trigger-legit raw delete).
// ---------------------------------------------------------------------------

/** Escape LIKE wildcards in operator-supplied text (mirror of
 *  src/project-briefs.ts:477 / src/store.ts:782, kept local since neither is
 *  exported). Used so a `%`/`_`/`\` in the vault name cannot over-match the
 *  loader prefix and archive another vault's rows. */
function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
}

/** Minimal inline frontmatter split. Recognises a leading `---\n…\n---\n`
 *  block (no YAML dep). Returns the parsed key→value map plus the body with the
 *  block removed. When no well-formed block is present, `fm` is empty and
 *  `body` is the original content. */
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
      // YAML block-style list: `key:` followed by indented `- item` lines
      // (common in Obsidian/Dendron frontmatter). Collect them into a
      // comma-joined value so frontmatterList parses them (codex P2).
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

/** Pull a frontmatter field that may be a YAML flow list (`[a, b]`), a
 *  comma-separated scalar (`a, b`), or a single token, into a string[]. Quotes
 *  and surrounding brackets are stripped; empty entries dropped. */
function frontmatterList(value: string | undefined): string[] {
  if (!value) return [];
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** Parse `[[wikilinks]]` from body text. `[[target]]` and `[[target|alias]]`
 *  both yield `target` (alias dropped). Returns de-duplicated, order-preserving
 *  target strings (trimmed). Embeds (`![[…]]`) are intentionally matched too —
 *  the leading `!` is not part of the `[[…]]` capture, so an embed contributes
 *  its target as a candidate, which is the desired no-crash baseline behaviour. */
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

/** Recursively collect `*.md` files under `root`, returning paths relative to
 *  `root` with forward-slash separators (stable artifactRef keys across OSes).
 *  Symlinks are not followed. Skips dot-directories (the default `.hippo` store,
 *  `.git`, `.obsidian`, `.trash`) AND the resolved Hippo store path during the
 *  walk, so re-importing a vault that CONTAINS the store never ingests its own
 *  markdown mirror files (codex R5 P1: `hippo import --vault .` after `hippo
 *  init` in the vault would otherwise self-import its mirror rows and grow on
 *  every run). The root-IS-the-store case is handled one level up in
 *  importVault (a no-op early return), NOT here: returning [] for it would feed
 *  the deletion-sync an empty scan that mass-archives every live row (codex R8). */
function collectMarkdownFiles(root: string, hippoRoot: string): string[] {
  const out: string[] = [];
  const resolvedHippoRoot = path.resolve(hippoRoot);
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip dot-dirs (config/system, incl. the default `.hippo` store) and
        // the resolved store path (covers a HIPPO_HOME outside `.hippo`).
        if (ent.name.startsWith('.')) continue;
        if (path.resolve(abs) === resolvedHippoRoot) continue;
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

interface VaultRow {
  id: string;
  artifact_ref: string;
  tags_json: string;
}

/**
 * Import a markdown vault FOLDER as `kind='raw'` memories.
 *
 * NOT re-entrant: idempotency rests on the in-memory `existing` Map loaded once
 * at the top. Two concurrent importVault runs over the same vault could both see
 * a note as absent and double-insert (the connector pattern relies on a single
 * sequential writer; same caveat applies here).
 */
export function importVault(folderPath: string, options: ImportOptions): ImportResult {
  const hippoRoot = options.hippoRoot;
  const tenantId = options.tenantId ?? 'default';
  const vaultName = options.name ?? path.basename(path.resolve(folderPath));
  if (vaultName.includes(':')) {
    // ':' is the artifactRef delimiter (vault:<name>:<relpath>); a name
    // containing it lets a different vault's prefix scan over-match and archive
    // its rows (codex P2). Reject rather than silently corrupt the keys.
    throw new Error(`vault name must not contain ':' (artifactRef delimiter): ${vaultName}`);
  }
  const scope = options.scope ?? null;
  const extraTags = options.extraTags ?? [];
  const dryRun = options.dryRun ?? false;
  if (options.global) {
    // The raw-archive path is tenant-local; global mode would put raw vault rows
    // in the wrong store. Reject for SDK callers too (the CLI also rejects
    // --global) rather than silently writing local (codex P2).
    throw new Error('importVault does not support global mode (raw rows are tenant-local).');
  }

  // Self-store no-op guard (codex R8 P1). MUST run BEFORE the existing-rows load
  // and the deletion-sync pass below. If the vault folder IS the store (or lives
  // inside it), there are no real vault notes - only the store's own markdown
  // mirror files. Letting collectMarkdownFiles return [] for this case is NOT
  // safe: an empty scan is indistinguishable from "every note was deleted", so
  // deletion-sync would archive every live vault:<name>:* row, and raw-archive
  // content redaction makes that loss IRREVERSIBLE. The only safe reading of
  // "import the store into itself" is "do nothing".
  const resolvedStore = path.resolve(hippoRoot);
  const resolvedFolder = path.resolve(folderPath);
  if (resolvedFolder === resolvedStore || resolvedFolder.startsWith(resolvedStore + path.sep)) {
    return { total: 0, imported: 0, skipped: 0, archived: 0, entries: [] };
  }

  const ctx: Context = {
    hippoRoot,
    tenantId,
    // Process-local actor; the vault importer is a CLI/SDK ingestion path, not
    // a bearer-authed request. archiveRaw / remember thread this into audit.
    actor: { subject: 'connector:vault', role: 'admin' },
  };

  // Load ONCE: every existing raw row for this vault, tenant-scoped. The same
  // Map serves both per-file idempotency AND the deletion diff (no second
  // query). LIKE-escape the vault name so a `%`/`_` in it can't over-match.
  initStore(hippoRoot);
  // artifactRef -> ALL its live raw rows. >1 only after a concurrent double-insert
  // (the importer is not re-entrant; see the JSDoc). The buckets matter: a later
  // changed/deletion pass must archive EVERY matching row, not just the last one
  // scanned, or older raw vault content lingers live + searchable (codex P2).
  const existing = new Map<string, VaultRow[]>();
  {
    const db = openHippoDb(hippoRoot);
    try {
      const likeParam = `vault:${escapeLike(vaultName)}:%`;
      const rows = db
        .prepare(
          `SELECT id, artifact_ref, tags_json FROM memories
             WHERE artifact_ref LIKE ? ESCAPE '\\' AND tenant_id = ? AND kind = 'raw'`,
        )
        .all(likeParam, tenantId) as VaultRow[];
      // SQLite LIKE is case-insensitive for ASCII, so the query over-fetches
      // (vault 'A' also matches 'vault:a:%'). Filter to the EXACT-case prefix in
      // JS so deletion-sync never archives a different-cased vault's rows (codex P2).
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

    // Content-hash is computed from the RAW file bytes (deterministic; no
    // Date/random in the content path) so idempotency survives frontmatter
    // edits identically to body edits.
    let rawFileContent: string;
    try {
      rawFileContent = fs.readFileSync(path.join(folderPath, relpath), 'utf8');
    } catch {
      // File vanished between enumeration and read (TOCTOU), or a transient
      // IO/permission error. Skip this one file rather than aborting the whole
      // import (incl. the deletion-sync pass); an idempotent re-run picks it up.
      skipped++;
      continue;
    }
    const hash = createHash('sha256').update(rawFileContent).digest('hex');
    const hashTag = `content-hash:${hash}`;

    const priors = existing.get(artifactRef) ?? [];
    // Unchanged iff EVERY live raw row already carries the current content-hash
    // (the normal case is exactly one row; >1 only after a concurrent double-
    // insert). If ANY row is stale / missing the hash, treat the file as changed
    // so the archive pass below removes ALL of them, not just the matching one
    // (codex P2). The `length > 0` guard is required: `[].every()` is vacuously
    // true, but a never-seen file (no rows) must fall through to import, not skip.
    if (priors.length > 0 && priors.every((p) => parseJsonArrayLoose(p.tags_json).includes(hashTag))) {
      // Unchanged file → skip (idempotent re-import).
      skipped++;
      continue;
    }

    const { fm, body } = parseFrontmatter(rawFileContent);

    // Empty / frontmatter-only note: nothing storable (createMemory enforces a
    // min content length). Skip WITHOUT archiving any prior row — archiving
    // first then throwing on the empty body would delete a live memory mid-run
    // (codex P2). The note stays in `seen`, so deletion-sync won't archive it.
    if (body.trim().length < 3) {
      skipped++;
      continue;
    }

    // Changed file → archive EVERY old raw row for this ref (normally one; >1
    // only after a concurrent double-insert), then append the new one. NEVER
    // supersede (would yield kind='distilled'). archiveRaw commits + closes its
    // handle before remember() runs, so there is no double-live row; a crash
    // between them self-heals (file re-imported as fresh raw next run).
    for (const p of priors) {
      archived++; // count the would-be archive even in dryRun (true preview)
      if (!dryRun) archiveRaw(ctx, p.id, `changed:${artifactRef}`);
    }
    const frontmatterTags = [
      ...frontmatterList(fm['tags']),
      ...frontmatterList(fm['aliases']).map((a) => `alias:${a}`),
    ];
    const wikilinkTags = parseWikilinks(body).map((t) => `wikilink-candidate:${t}`);

    // De-duplicate the final tag array (createMemory stores tags verbatim, so a
    // collision between, e.g., a frontmatter tag and an extraTag would otherwise
    // produce a duplicate). Order-preserving.
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

    // remember() owns the actual write. We build an `echo` of the SAME content +
    // tags via createMemory purely for the ImportResult, then reconcile its id to
    // remember()'s real row id so entries[] reflects the row that landed.
    const echo = createMemory(body, {
      kind: 'raw',
      tags,
      scope,
      owner: 'agent:vault-import',
      artifact_ref: artifactRef,
      tenantId,
    });
    // dryRun preview: count what WOULD import, but make no writes (codex P2).
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

  // Deletion-sync: any artifactRef present in the Map but NOT seen this run is a
  // note that vanished from the source folder → archive its raw row. Per-file
  // archiveRaw (own handle); no outer SAVEPOINT (no cross-file idempotency row
  // to commit atomically, unlike github's multi-row case).
  for (const [artifactRef, rows] of existing) {
    if (seen.has(artifactRef)) continue;
    for (const row of rows) {
      archived++; // count even in dryRun so the preview reflects destructive deletes
      if (!dryRun) archiveRaw(ctx, row.id, `source_deleted:${artifactRef}`);
    }
  }

  return { total, imported, skipped, archived, entries };
}

/** Local tolerant JSON-array parse for the loader's `tags_json` column. The
 *  store's own `parseJsonArray` is not exported; this matches its contract
 *  (returns [] on null/garbage). */
function parseJsonArrayLoose(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
