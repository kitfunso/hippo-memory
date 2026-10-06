import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { createMemory, MemoryEntry } from '../memory.js';
import { initStore } from '../store/open.js';
import { remember, archiveRaw, isPrivateScope, type Context } from '../api.js';
import { assertClientScope } from '../recall-scope.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { RejectedValueError, checkRejectionGuard } from '../rejection.js';
import { loadConfig } from '../config.js';
import { vetSecrets } from '../secret-detect.js';
import { log } from '../log.js';
import { type ImportResult, type ImportOptions } from './core.js';
import { parseFrontmatter, frontmatterList, parseWikilinks, collectMarkdownFiles, realpathOrResolve } from './markdown-parse.js';
import { type JsonValue, isJsonString } from '../json.js';
import { escapeLike } from '../escape.js';

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

interface VaultRow {
  id: string;
  artifact_ref: string;
  tags_json: string;
  scope: string | null;
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
  const { vaultName, scope } = vaultIdentityOrThrow(options);
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
  // "import the store into itself" is "do nothing". Canonicalize both paths
  // (realpath: dereference junctions/symlinks + normalize Windows case) so an
  // aliased path to the store is still caught (codex R9 P2).
  const resolvedStore = realpathOrResolve(hippoRoot);
  const resolvedFolder = realpathOrResolve(folderPath);
  if (resolvedFolder === resolvedStore || resolvedFolder.startsWith(resolvedStore + path.sep)) {
    return { total: 0, imported: 0, skipped: 0, rejected: 0, archived: 0, entries: [] };
  }

  const ctx: Context = {
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

  // AT1 P2 fix: dry-run never called remember(), so it never probed
  // tombstones — every note that reached the write step counted as
  // `imported` even when a real run would refuse it. Probe (read-only) via
  // the same guard remember()/writeEntry uses, without ever writing.
  const dryRunDb = dryRun ? openHippoDb(hippoRoot) : null;
  try {
    const run: VaultImportRun = {
      ctx, folderPath, vaultName, scope, extraTags, dryRun, dryRunDb, existing, seen, baseHalfLifeDays, tally,
    };
    for (const relpath of relpaths) importVaultNote(run, relpath);
  } finally {
    if (dryRunDb) closeHippoDb(dryRunDb);
  }

  // Deletion-sync: any artifactRef present in the Map but NOT seen this run is a
  // note that vanished from the source folder → archive its raw row. Per-file
  // archiveRaw (own handle); no outer SAVEPOINT (no cross-file idempotency row
  // to commit atomically, unlike github's multi-row case).
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
  ctx: Context;
  folderPath: string;
  vaultName: string;
  scope: string | null;
  extraTags: string[];
  dryRun: boolean;
  dryRunDb: ReturnType<typeof openHippoDb> | null;
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
  // Vault NAME is the identity key for the destructive deletion-sync below, so it
  // must be explicit. Defaulting to the folder basename meant two unrelated vaults
  // sharing a basename (e.g. work/notes and personal/notes) collided on the same
  // `vault:<name>:*` prefix - importing the second loaded the first's rows and the
  // deletion-sync archived them (codex R10 P2). Require a deliberate name instead
  // of inferring a path-unstable one.
  const vaultName = options.name?.trim();
  if (!vaultName) {
    throw new Error(
      'importVault requires an explicit vault name (options.name): it is the identity key for source-deletion sync and must not be inferred from the folder basename.',
    );
  }
  if (vaultName.includes(':')) {
    // ':' is the artifactRef delimiter (vault:<name>:<relpath>); a name
    // containing it lets a different vault's prefix scan over-match and archive
    // its rows (codex P2). Reject rather than silently corrupt the keys.
    throw new Error(`vault name must not contain ':' (artifactRef delimiter): ${vaultName}`);
  }
  const scope = options.scope ?? null;
  // Privacy footgun guard (codex R13 P2): hippo's recall filter only default-denies
  // scopes shaped `<source>:private:*` (see isPrivateScope / PRIVATE_SCOPE_RE in
  // scope.ts). A bare `private` (or `private:<x>`) first segment is NOT recognized
  // as private, so notes a user believes are private would still be returned to
  // no-scope recall callers. Reject the alias and point at the source-prefixed form
  // rather than silently storing public-visible "private" notes. Use recall's own
  // isPrivateScope as the single source of truth: reject a scope that names a
  // `private` segment yet is NOT a valid `<source>:private:*` (catches `private`,
  // `private:x`, and `vault:private` with a missing trailing segment).
  assertClientScope(scope);
  if (scope !== null && scope.split(':').includes('private') && !isPrivateScope(scope)) {
    throw new Error(
      `vault scope '${scope}' is not recognized as private by recall (only '<source>:private:*' scopes are default-denied). Use a source-prefixed scope such as 'vault:private:${vaultName}'.`,
    );
  }
  return { vaultName, scope };
}

function loadVaultRows(hippoRoot: string, tenantId: string, vaultName: string): Map<string, VaultRow[]> {
  // Load ONCE: every existing raw row for this vault, tenant-scoped. The same
  // Map serves both per-file idempotency AND the deletion diff (no second
  // query). LIKE-escape the vault name so a `%`/`_` in it can't over-match.
  initStore(hippoRoot);
  // artifactRef -> ALL its live raw rows. >1 only after a concurrent double-insert
  // (the importer is not re-entrant; see the JSDoc). The buckets matter: a later
  // changed/deletion pass must archive EVERY matching row, not just the last one
  // scanned, or older raw vault content lingers live + searchable (codex P2).
  const existing = new Map<string, VaultRow[]>();
  const db = openHippoDb(hippoRoot);
  try {
    const likeParam = `vault:${escapeLike(vaultName)}:%`;
    // SAFETY: query selects exactly the columns of VaultRow, in the same
    // names, from the memories table this module owns.
    const rows = db
      .prepare(
        `SELECT id, artifact_ref, tags_json, scope FROM memories
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
  return existing;
}

function importVaultNote(run: VaultImportRun, relpath: string): void {
  const { ctx, tally } = run;
  tally.total++;
  const artifactRef = `vault:${run.vaultName}:${relpath}`;
  run.seen.add(artifactRef);

  // Content-hash is computed from the RAW file bytes (deterministic; no
  // Date/random in the content path) so idempotency survives frontmatter
  // edits identically to body edits.
  const rawFileContent = readVaultNote(run, relpath);
  if (rawFileContent === null) return;
  const hash = createHash('sha256').update(rawFileContent).digest('hex');
  const hashTag = `content-hash:${hash}`;

  // Load every live raw row for this ref (>1 only after a concurrent double-
  // insert). The idempotency decision happens below, AFTER the full tag set is
  // built, so it can compare the complete envelope rather than a subset.
  const priors = run.existing.get(artifactRef) ?? [];

  const { fm, body } = parseFrontmatter(rawFileContent);

  // Empty / frontmatter-only note: nothing storable (createMemory enforces a
  // min content length). The note's CONTENT was deleted at source, so this is a
  // content-deletion: archive any prior row(s) - the old body must not stay live
  // and searchable after the source no longer holds it (codex R12 P2) - then
  // skip the write. Archiving here is safe precisely because we then skip
  // remember() entirely: there is no archive-then-throw-on-empty-body hazard
  // (the original reason this branch did not archive). The note stays in `seen`
  // so deletion-sync does not double-process it.
  if (body.trim().length < 3) {
    archivePriors(run, priors, `emptied:${artifactRef}`);
    tally.skipped++;
    return;
  }

  const tags = vaultNoteTags(run, hashTag, fm, body);
  if (vaultEnvelopeUnchanged(priors, tags, run.scope)) {
    // Unchanged file + envelope → skip (idempotent re-import).
    tally.skipped++;
    return;
  }

  // Changed file → archive EVERY old raw row for this ref (normally one; >1
  // only after a concurrent double-insert), then append the new one. NEVER
  // supersede (would yield kind='distilled'). archiveRaw commits + closes its
  // handle before remember() runs, so there is no double-live row; a crash
  // between them self-heals (file re-imported as fresh raw next run).
  archivePriors(run, priors, `changed:${artifactRef}`);

  // remember() owns the actual write. We build an `echo` of the SAME content +
  // tags via createMemory purely for the ImportResult, then reconcile its id to
  // remember()'s real row id so entries[] reflects the row that landed.
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
  } catch {
    // File vanished between enumeration and read (TOCTOU), or a transient
    // IO/permission error. Skip this one file rather than aborting the whole
    // import (incl. the deletion-sync pass); an idempotent re-run picks it up.
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
  // Build the FULL tag envelope this import would write, BEFORE the idempotency
  // decision. De-duplicate (createMemory stores tags verbatim, so a collision
  // between, e.g., a frontmatter tag and an extraTag would otherwise produce a
  // duplicate). Order-preserving.
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
  // Unchanged iff EVERY live raw row carries the EXACT same tag set AND scope.
  // Comparing the COMPLETE set (not the content-hash + a subset of extra tags)
  // means every envelope change registers: content (via the content-hash tag),
  // frontmatter, wikilinks, an ADDED extra tag, or a REMOVED one - the earlier
  // piecemeal checks missed scope (R10 P2) then tag removal (R11 P2). Set
  // equality is order-independent and both sides are deduped. (`length > 0`
  // guard: a never-seen file must import, not skip; archiving ALL priors on a
  // mismatch also clears any concurrent-double-insert duplicates.)
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
  try {
    // dryRun preview: count what WOULD import, but make no writes (codex P2).
    if (!run.dryRun) {
      // AT1 (plan §3 containment): a rejected note must not abort the rest
      // of the vault scan (deletion-sync pass included). The priors above
      // are already archived by this point — same self-heal story as any
      // other crash between archiveRaw and remember() (comment above): a
      // re-run with the file still rejected hits the same refusal again,
      // loud each time via the rejected count.
      const result = remember(run.ctx, {
        content,
        kind: 'raw',
        artifactRef,
        owner: 'agent:vault-import',
        scope: run.scope ?? undefined,
        tags,
      });
      echo.id = result.id;
    } else if (run.dryRunDb) {
      // AT1 P2 fix: probe the tombstone without writing so the preview's
      // `rejected` count matches what a real run would refuse.
      checkRejectionGuard(run.dryRunDb, run.ctx.tenantId, echo.id, echo.content);
    }
    return true;
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
}

/** Local tolerant JSON-array parse for the loader's `tags_json` column. The
 *  store's own `parseJsonArray` is not exported; this matches its contract
 *  (returns [] on null/garbage). */
function parseJsonArrayLoose(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: JsonValue = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isJsonString) : [];
  } catch (err) {
    log.debug(`import: unreadable tags_json read as no tags: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
