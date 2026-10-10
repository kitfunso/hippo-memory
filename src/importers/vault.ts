import { DEFAULT_TENANT_ID } from '../util/env.js';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { createMemory, MemoryEntry } from '../core/memory.js';
import { loadVaultRawRows, type VaultRawRow } from '../store/entry-reads.js';
import { remember, archiveRaw, isPrivateScope, type HippoDbContext } from '../api/index.js';
import { assertClientScope } from '../store/recall-scope.js';
import { RejectedValueError } from '../store/rejection.js';
import { rejectionGuardRefuses } from '../store/rejected-values.js';
import { withRequestStoresSync } from '../db/request-stores.js';
import { loadConfig } from '../core/config.js';
import { vetSecrets } from '../util/secret-detect.js';
import { errorMessage, log } from '../util/log.js';
import { type ImportResult, type ImportOptions } from './core.js';
import { splitMarkdownFrontmatter, frontmatterList, parseWikilinks, collectMarkdownFiles } from './markdown-parse.js';
import { realpathOrResolve } from '../util/real-path.js';
import { type JsonValue, isJsonString } from '../util/json.js';
import { escapeLike } from '../util/escape.js';

// K1 vault importer (markdown-vault FOLDER -> kind='raw' memories), following the connector pattern (src/connectors/slack|github).
// A changed note appends a new raw row after archiveRaw of the old one; NEVER `supersede` a raw row (it yields 'distilled' and escapes the deletion rescan).

type VaultRow = VaultRawRow;

/** Import a markdown vault FOLDER as `kind='raw'` memories.
 *  NOT re-entrant: idempotency rests on the in-memory `existing` Map loaded once, so two concurrent runs over one vault can double-insert. */
export function importVault(folderPath: string, options: ImportOptions): ImportResult {
  const hippoRoot = options.hippoRoot;
  const identity = vaultIdentityOrThrow(options);
  if (options.global) {
    // The raw-archive path is tenant-local, so global mode would put raw vault rows in the wrong store; reject for SDK callers too, not only the CLI.
    throw new Error('importVault does not support global mode (raw rows are tenant-local).');
  }

  // Self-store no-op guard: MUST run before the existing-rows load and the deletion-sync. If the vault IS (or sits inside) the store, an empty scan looks like
  // "every note deleted" and deletion-sync would irreversibly archive every live row, so do nothing. Canonicalize both paths (realpath) to catch aliased paths.
  const resolvedStore = realpathOrResolve(hippoRoot);
  const resolvedFolder = realpathOrResolve(folderPath);
  if (resolvedFolder === resolvedStore || resolvedFolder.startsWith(resolvedStore + path.sep)) {
    return { total: 0, imported: 0, skipped: 0, rejected: 0, archived: 0, entries: [] };
  }
  return syncVaultFolder(folderPath, options, identity);
}

function syncVaultFolder(folderPath: string, options: ImportOptions, { vaultName, scope }: VaultIdentity): ImportResult {
  const hippoRoot = options.hippoRoot;
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const extraTags = options.extraTags ?? [];
  const dryRun = options.dryRun ?? false;

  const ctx: HippoDbContext = {
    hippoRoot,
    tenantId,
    // Process-local actor; the vault importer is a CLI/SDK ingestion path, not
    // a bearer-authed request. archiveRaw / remember thread this into audit.
    actor: { subject: 'connector:vault', role: 'admin' },
  };

  const existing = loadVaultRows(hippoRoot, tenantId, vaultName);
  const relpaths = collectMarkdownFiles(folderPath, hippoRoot);
  const tally: VaultTally = { total: 0, imported: 0, skipped: 0, rejected: 0, archived: 0, redacted: 0, entries: [] };
  const baseHalfLifeDays = loadConfig(hippoRoot).defaultHalfLifeDays;
  const seen = new Set<string>();

  const run: VaultImportRun = {
    ctx, folderPath, vaultName, scope, extraTags, dryRun, existing, seen, baseHalfLifeDays, tally,
  };
  const importNotes = (): void => {
    for (const relpath of relpaths) importVaultNote(run, relpath);
  };
  // A dry run probes the rejection guard once per changed note; one scope lets every probe share a handle.
  if (dryRun) withRequestStoresSync(importNotes);
  else importNotes();

  // Deletion-sync: an artifactRef in the Map but not seen this run vanished from the source, so archive its raw row.
  // Per-file archiveRaw, no outer SAVEPOINT: there is no cross-file idempotency row to commit atomically.
  for (const [artifactRef, rows] of existing) {
    if (seen.has(artifactRef)) continue;
    for (const row of rows) {
      tally.archived++; // count even in dryRun so the preview reflects destructive deletes
      if (!dryRun) archiveRaw(ctx, row.id, `source_deleted:${artifactRef}`);
    }
  }

  const { total, imported, skipped, rejected, archived, redacted, entries } = tally;
  return { total, imported, skipped, rejected, archived, redacted, entries };
}

interface VaultTally {
  total: number;
  imported: number;
  skipped: number;
  rejected: number;
  archived: number;
  redacted: number;
  entries: MemoryEntry[];
}

interface VaultImportRun {
  ctx: HippoDbContext;
  folderPath: string;
  vaultName: string;
  scope: string | null;
  extraTags: string[];
  dryRun: boolean;
  existing: Map<string, VaultRow[]>;
  seen: Set<string>;
  baseHalfLifeDays: number;
  tally: VaultTally;
}

interface VaultIdentity {
  vaultName: string;
  scope: string | null;
}

function vaultIdentityOrThrow(options: ImportOptions): VaultIdentity {
  // The vault NAME keys the destructive deletion-sync, so it must be explicit: defaulting to the folder basename made two vaults
  // sharing a basename collide on the same `vault:<name>:*` prefix and the sync archived the first one's rows.
  const vaultName = options.name?.trim();
  if (!vaultName) {
    throw new Error(
      'importVault requires an explicit vault name (options.name): it is the identity key for source-deletion sync and must not be inferred from the folder ' +
        'basename.',
    );
  }
  if (vaultName.includes(':')) {
    // ':' delimits the artifactRef (vault:<name>:<relpath>); a name containing it lets another vault's prefix scan over-match and archive its rows.
    throw new Error(`vault name must not contain ':' (artifactRef delimiter): ${vaultName}`);
  }
  const scope = options.scope ?? null;
  // Privacy guard: recall only default-denies scopes shaped `<source>:private:*` (isPrivateScope in src/store/recall-scope.ts), so a bare `private`
  // alias would be returned to no-scope callers. Reject any scope naming a `private` segment that is not a valid `<source>:private:*`.
  assertClientScope(scope);
  if (scope !== null && scope.split(':').includes('private') && !isPrivateScope(scope)) {
    throw new Error(
      `vault scope '${scope}' is not recognized as private by recall (only '<source>:private:*' scopes are default-denied). Use a source-prefixed scope such as 'vault:private:${vaultName}'.`,
    );
  }
  return { vaultName, scope };
}

function loadVaultRows(hippoRoot: string, tenantId: string, vaultName: string): Map<string, VaultRow[]> {
  // One load serves both per-file idempotency and the deletion diff; the vault name is
  // LIKE-escaped so a `%` or `_` in it cannot over-match.
  const rows = loadVaultRawRows(hippoRoot, `vault:${escapeLike(vaultName)}:%`, tenantId);
  // Every live row per artifactRef (more than one only after a concurrent double-insert), because a
  // later changed or deletion pass must archive them all or older raw vault content stays searchable.
  const existing = new Map<string, VaultRow[]>();
  // LIKE folds ASCII case (vault 'A' also matches 'vault:a:%'), so the exact-case prefix is checked
  // here; without it deletion-sync would archive a different-cased vault's rows.
  const exactPrefix = `vault:${vaultName}:`;
  for (const row of rows) {
    if (row.artifact_ref && row.artifact_ref.startsWith(exactPrefix)) {
      const bucket = existing.get(row.artifact_ref);
      if (bucket) bucket.push(row);
      else existing.set(row.artifact_ref, [row]);
    }
  }
  return existing;
}

function importVaultNote(run: VaultImportRun, relpath: string): void {
  const { tally } = run;
  tally.total++;
  const artifactRef = `vault:${run.vaultName}:${relpath}`;
  run.seen.add(artifactRef);

  // The content hash covers the RAW file bytes (deterministic, no Date/random) so frontmatter edits are idempotent like body edits.
  const rawFileContent = readVaultNote(run, relpath);
  if (rawFileContent === null) return;
  const hash = createHash('sha256').update(rawFileContent).digest('hex');
  const hashTag = `content-hash:${hash}`;

  // Load every live raw row for this ref (>1 only after a concurrent double-insert); decide idempotency below, once the full tag set is built.
  const priors = run.existing.get(artifactRef) ?? [];

  const { fm, body } = splitMarkdownFrontmatter(rawFileContent);

  // Empty or frontmatter-only note: nothing storable, and the content was deleted at source, so archive prior rows (the old body must not stay searchable)
  // and skip the write. Safe because remember() is skipped, so there is no archive-then-throw hazard; the note stays in `seen` so deletion-sync skips it.
  if (body.trim().length < 3) {
    archivePriors(run, priors, `emptied:${artifactRef}`);
    tally.skipped++;
    return;
  }

  const tags = vaultNoteTags(run, hashTag, fm, body);  if (vaultEnvelopeUnchanged(priors, tags, run.scope)) {
    // Unchanged file + envelope → skip (idempotent re-import).
    tally.skipped++;
    return;
  }
  writeChangedNote(run, artifactRef, priors, body, tags);
}

function writeChangedNote(run: VaultImportRun, artifactRef: string, priors: VaultRow[], body: string, tags: string[]): void {
  const { ctx, tally } = run;
  // Changed file: archive EVERY old raw row for this ref (>1 only after a concurrent double-insert), then append the new one; NEVER supersede.
  // archiveRaw commits before remember() runs, so no double-live row; a crash between them self-heals on the next import.
  archivePriors(run, priors, `changed:${artifactRef}`);

  // remember() owns the write; the `echo` from createMemory only fills the ImportResult, with its id reconciled to the row that landed.
  const content = vetSecrets(body, tags, true).content;
  const echo = createMemory(content, {
    kind: 'raw',
    tags,
    scope: run.scope,
    owner: 'agent:vault-import',
    artifact_ref: artifactRef,
    tenantId: ctx.tenantId,
    baseHalfLifeDays: run.baseHalfLifeDays,
  });
  if (!storeVaultNote(run, echo, content, tags, artifactRef)) {
    tally.rejected++;
    return;
  }
  tally.entries.push(echo);
  tally.imported++;
  if (content !== body) tally.redacted++;
}

function readVaultNote(run: VaultImportRun, relpath: string): string | null {
  try {
    return fs.readFileSync(path.join(run.folderPath, relpath), 'utf8');
  } catch (err) {
    // One unreadable note (gone since the listing, or a transient IO error) must not abort the import; a re-run picks it up.
    log.debug(`vault note skipped: ${relpath}: ${errorMessage(err)}`);
    run.tally.skipped++;
    return null;
  }
}

function archivePriors(run: VaultImportRun, priors: readonly { id: string }[], reason: string): void {
  for (const p of priors) {
    run.tally.archived++; // count the would-be archive even in dryRun (true preview)
    if (!run.dryRun) archiveRaw(run.ctx, p.id, reason);
  }
}

function vaultNoteTags(run: VaultImportRun, hashTag: string, fm: Record<string, string>, body: string): string[] {
  // Build the FULL tag envelope before the idempotency decision, de-duplicated and order-preserving (createMemory stores tags verbatim).
  const frontmatterTags = [
    ...frontmatterList(fm['tags']),
    ...frontmatterList(fm['aliases']).map((a) => `alias:${a}`),
  ];
  const wikilinkTags = parseWikilinks(body).map((t) => `wikilink-candidate:${t}`);
  return Array.from(
    new Set([
      'source:vault',
      `vault:${run.vaultName}`,
      hashTag,
      ...frontmatterTags,
      ...wikilinkTags,
      ...run.extraTags,
    ]),
  );
}

function vaultEnvelopeUnchanged(priors: VaultRow[], tags: string[], scope: string | null): boolean {
  // Unchanged iff EVERY live raw row carries the EXACT same tag set AND scope; comparing the complete envelope (not hash plus a subset) catches
  // scope, added and removed tags. `length > 0` guards a never-seen file; archiving all priors on a mismatch also clears concurrent double-inserts.
  const wantTags = new Set(tags);
  return (
    priors.length > 0 &&
    priors.every((p) => {
      if ((p.scope ?? null) !== scope) return false;
      const priorTags = parseJsonArrayLoose(p.tags_json);
      return priorTags.length === wantTags.size && priorTags.every((t) => wantTags.has(t));
    })
  );
}

/** Returns false when the rejection guard refuses the note; any other error propagates. */
function storeVaultNote(run: VaultImportRun, echo: MemoryEntry, content: string, tags: string[], artifactRef: string): boolean {
  // A dry run writes nothing; it asks the guard remember() uses, so its `rejected` count matches what a real run would refuse.
  if (run.dryRun) return !rejectionGuardRefuses(run.ctx.hippoRoot, run.ctx.tenantId, echo.id, echo.content);
  try {
    // A rejected note must not stop the scan or the deletion sync. Its priors are archived by now, so a rerun meets
    // the same refusal and counts it again.
    const result = remember(run.ctx, {
      content,
      kind: 'raw',
      artifactRef,
      owner: 'agent:vault-import',
      scope: run.scope ?? undefined,
      tags,
    });
    echo.id = result.id;
    return true;
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
}

/** Tolerant JSON-array parse for the loader's `tags_json` column (the store's `parseJsonArray` is not exported); returns [] on null or garbage. */
function parseJsonArrayLoose(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: JsonValue = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isJsonString) : [];
  } catch (err) {
    log.debug(`import: unreadable tags_json read as no tags: ${errorMessage(err)}`);
    return [];
  }
}
