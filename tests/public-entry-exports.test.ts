import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../src/index.js';
import { strengthBucket } from '../src/consolidate/dedupe.js';
import { sleep } from '../src/api/sleep.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs `script` in a child and returns the JSON on its last stdout line. */
function importBuiltEntry<T>(script: string): T {
  // cwd is the checkout, not a temp dir, because self-reference resolves from the nearest package.json; the children only import and call pure functions.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (child.status !== 0) {
    throw new Error(
      `self-reference import failed (run \`npm run build\` first):\n${child.error?.message ?? ''}${child.stderr}`,
    );
  }
  const lines = child.stdout.trim().split('\n');
  // SAFETY: each caller's script is the only writer of the last stdout line and always emits the keys of T.
  return JSON.parse(lines[lines.length - 1]) as T;
}

// Announced public in CHANGELOG 1.26.3; guards the entry surface, which no other test imports through.
describe('package entry re-exports strengthBucket', () => {
  it('src/index.ts exposes the same function dedupe.ts defines', () => {
    expect(entry.strengthBucket).toBe(strengthBucket);
    expect(entry.strengthBucket(1)).toBe(100);
  });

  it('the built package resolves it by name from this checkout', () => {
    const script = [
      "const url = import.meta.resolve('hippo-memory');",
      "const m = await import('hippo-memory');",
      'console.log(JSON.stringify({ url, type: typeof m.strengthBucket, one: m.strengthBucket?.(1) }));',
    ].join('\n');
    const out = importBuiltEntry<{ url: string; type: string; one: number }>(script);
    expect(realpathSync(fileURLToPath(out.url))).toBe(realpathSync(resolve(REPO_ROOT, 'dist', 'index.js')));
    expect(out.type).toBe('function');
    expect(out.one).toBe(100);
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export \{ strengthBucket \} from '\.\/consolidate\/dedupe\.js';$/m);
  });
});

// An add-on runs consolidation in its own process; adminActor stays internal because sleep reads only actor.subject.
describe('package entry re-exports sleep', () => {
  it('src/index.ts exposes the same function api/sleep.ts defines, and not adminActor', () => {
    expect(entry.sleep).toBe(sleep);
    expect('adminActor' in entry).toBe(false);
  });

  it('the built package resolves sleep by name and ships its option and result types', () => {
    const script = [
      "const m = await import('hippo-memory');",
      "console.log(JSON.stringify({ type: typeof m.sleep, admin: 'adminActor' in m }));",
    ].join('\n');
    const out = importBuiltEntry<{ type: string; admin: boolean }>(script);
    expect(out.type).toBe('function');
    expect(out.admin).toBe(false);
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export \{ sleep, type SleepOpts, type SleepResult \} from '\.\/api\/sleep\.js';$/m);
    // The phase-override seam lives in sleep-run.ts, so the public declaration must not name it.
    expect(readFileSync(resolve(REPO_ROOT, 'dist', 'api', 'sleep.d.ts'), 'utf-8')).not.toMatch(/__phases|SleepPhases/);
  });
});

/** One line per initial letter, so a snapshot diff shows the one name that came or went. */
function byInitial(names: readonly string[]): string {
  const lines = new Map<string, string[]>();
  for (const name of [...names].sort()) lines.set(name[0], [...(lines.get(name[0]) ?? []), name]);
  return [...lines.values()].map((line) => line.join(' ')).join('\n');
}

// The one list of what the built package publishes at runtime: a name leaving an entry breaks an installed add-on.
describe('published runtime exports', () => {
  it('lists every name each package entry exports', () => {
    const script = [
      "import { readFileSync } from 'node:fs';",
      "const subpaths = Object.keys(JSON.parse(readFileSync('package.json', 'utf-8')).exports);",
      'const names = {};',
      "for (const subpath of subpaths) names[subpath] = Object.keys(await import('hippo-memory' + subpath.slice(1)));",
      'console.log(JSON.stringify(names));',
    ].join('\n');
    const names = importBuiltEntry<Record<string, string[]>>(script);
    expect(Object.fromEntries(Object.entries(names).map(([subpath, list]) => [subpath, byInitial(list)]))).toMatchInlineSnapshot(`
      {
        ".": "AUDIT_OPS
      CARD_LEASE_MS CARD_TRANSITIONS
      DEFAULT_MAX_NEIGHBORS
      Layer
      MAX_HOPS
      SNAPSHOT_AMBIENT_MAX_AGE_MS
      WM_MAX_ENTRIES
      addCardComment appendAuditEvent appendSessionEvent applyOutcome autoShare
      blockCard buildSyntheticCorpus
      calculateStrength captureError claimCard clearActiveTaskSnapshot closeHippoDb closeTaskSnapshotsForSession completeCard computeAmbientState computeSalience computeSchemaFit computeTemporalRange confidenceFacets consolidate cosineSimilarity createCard createMemory
      deduplicateLesson deleteEntry detectRegressions detectTemporalDirection
      embedAll embedMemory estimateTokens explainMatch extractLessons
      fetchGitLog formatAmbientVector formatResult
      generateId getEmbedding getGlobalRoot graphExpandRecall
      heartbeatCard hybridSearch
      importChatGPT importClaude importCursor importEntries importGenericFile importMarkdown importVault initGlobal initStore isCardStatus isEmbeddingAvailable isHandoffOutcome
      listAuditEventsAfter listCards listMemoryConflicts listPeers listSessionEvents loadActiveTaskSnapshot loadAllEntries loadCard loadCardComments loadCardDeps loadCardRuns loadEmbeddingIndex loadFreshActiveTaskSnapshot loadHandoffById loadIndex loadLatestHandoff loadLatestHandoffForCard loadRecallSearchEntries loadSearchEntries loadSessionDecayContext
      markRetrieved multihopSearch
      openHippoDb openHippoDbReadOnly
      partitionLessons physicsSearch promoteToGlobal
      queryAuditEvents
      readEntry rebuildIndex reclaimExpiredCards renderAmbientSummary replaceDetectedConflicts resolveConfidence resolveConflict resultToBaseline reviewCard runFeatureEval runWatched
      saveActiveTaskSnapshot saveEmbeddingIndex saveSessionHandoff search searchBoth searchBothHybrid shareMemory sleep stampHandoffOutcome strengthBucket syncGlobalToLocal
      temporalBoost textOverlap tokenize transferScore
      wmClear wmFlush wmPush wmRead writeEntry writeSessionEndHandoff",
        "./json-hooks": "installJsonHooks
      readJsonFile resolveJsonHookPaths
      uninstallJsonHooks
      writeSettingsFile",
        "./project-identity": "MAX_PROJECT_ALIASES MCP_PROJECT_SCOPED_HEADER
      resolveProjectIdentity",
        "./server": "BadRequestError
      ConflictError
      EMBEDDING_MODEL_META_KEY
      ForbiddenError
      HttpError
      LOOPBACK_HOST_HEADER
      NotFoundError
      OTHER_STORE_MARKER OtherStoreFolderError
      RECALL_DEFAULT_DENY_SCOPES RejectedValueError
      SECRET_TAGS StoreBusyError
      __resetSessionRecallHistoryHttp
      authCreate authCreateSelf authRevoke
      bindSessionOwner bufferToFloat32
      captureFailureForCaller captureSessionTexts clientIpForRateLimit compactResumeForCaller
      decodeVector
      encodeVector entryAfterOutcome
      float32ToBuffer ftsTermParts
      hasGroup
      isCrossSite isLoopback isReservedActor isSharedStore
      ownScopeTouches ownerOrSubject
      passesScopeFilterForRecall preCompactForCaller promptHookContext
      rankVectorRows rarestFtsQuery rejectionDigest replacesIndex
      saveCompactionItemsForCaller serve sessionEndHandoffForCaller sqliteStore
      tallyAmbientEntries
      withSqliteAllowed",
        "./session-text": "COMPACTION_ITEM_MAX_CHARS COMPACTION_ITEM_ROW_CAP
      WORKING_STATE_CAPS
      collectHandoffEvidence collectSessionTurns compactSummaryBody
      failureReport
      lessonFromFailure
      parseCompactionItems
      scrubForSharing sessionTail
      transcriptWorkingState",
      }
    `);
  });
});
