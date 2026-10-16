import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../src/index.js';
import { strengthBucket } from '../src/consolidate/dedupe.js';
import { initStore } from '../src/store/open.js';

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
    // The published d.ts text is what consumers compile against, so text is the contract.
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export \{ strengthBucket \} from '\.\/consolidate\/dedupe\.js';$/m);
  });
});

// An add-on runs consolidation in its own process; adminActor stays internal because sleep reads only actor.subject.
describe('package entry re-exports sleep', () => {
  it('src/index.ts exposes sleep and not adminActor', () => {
    expect(entry).toHaveProperty('sleep');
    expect('adminActor' in entry).toBe(false);
  });

  it('runs a Context that carries no store on hippo.db under its root', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-entry-sleep-'));
    const origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
    try {
      initStore(home);
      const result = await entry.sleep({ hippoRoot: home, tenantId: 'default', actor: { subject: 'test', role: 'admin' } }, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.active).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (origHippoHome !== undefined) process.env.HIPPO_HOME = origHippoHome;
      else delete process.env.HIPPO_HOME;
    }
  });

  it('the built package resolves sleep by name and ships its option and result types', () => {
    const script = [
      "const m = await import('hippo-memory');",
      "console.log(JSON.stringify({ type: typeof m.sleep, admin: 'adminActor' in m }));",
    ].join('\n');
    const out = importBuiltEntry<{ type: string; admin: boolean }>(script);
    expect(out.type).toBe('function');
    expect(out.admin).toBe(false);
    // The published d.ts text is what consumers compile against, so text is the contract.
    const dts = readFileSync(resolve(REPO_ROOT, 'dist', 'index.d.ts'), 'utf-8');
    expect(dts).toMatch(/^export type \{ SleepOpts, SleepResult \} from '\.\/api\/sleep\/sleep\.js';$/m);
    // The published signature takes the public Context, which may carry no store.
    expect(dts).toMatch(/^export declare function sleep\(ctx: Context, opts\?: SleepOpts\): Promise<SleepResult>;$/m);
    // The phase-override seam lives in sleep-run.ts, so the public declaration must not name it.
    expect(readFileSync(resolve(REPO_ROOT, 'dist', 'api', 'sleep', 'sleep.d.ts'), 'utf-8')).not.toMatch(/__phases|SleepPhases/);
  });
});

// The test seams live on their own subpath; a seam leaking back into /server or the root would ship test hooks to production callers.
describe('hippo-memory/testing', () => {
  it('resolves through the package exports map to dist/entry/testing.js and holds every reset seam', () => {
    const script = [
      "const url = import.meta.resolve('hippo-memory/testing');",
      "const m = await import('hippo-memory/testing');",
      "const server = await import('hippo-memory/server');",
      'console.log(JSON.stringify({ url, names: Object.keys(m).sort(), onServer: Object.keys(server).some((n) => /^_+reset/.test(n)) }));',
    ].join('\n');
    const out = importBuiltEntry<{ url: string; names: string[]; onServer: boolean }>(script);
    expect(realpathSync(fileURLToPath(out.url))).toBe(realpathSync(resolve(REPO_ROOT, 'dist', 'entry', 'testing.js')));
    expect(out.names.every((n) => /^_+reset\w+/.test(n))).toBe(true);
    expect(out.names).toContain('__resetSessionRecallHistoryHttp');
    expect(out.onServer).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'dist', 'entry', 'testing.d.ts'))).toBe(true);
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
      calculateStrength captureError claimCard clearActiveTaskSnapshot closeTaskSnapshotsForSession completeCard computeAmbientState computeSalience computeSchemaFit computeTemporalRange confidenceFacets consolidate cosineSimilarity createCard createMemory
      deduplicateLesson deleteEntry detectRegressions detectTemporalDirection
      embedAll embedMemory estimateTokens explainMatch extractLessons
      fetchGitLog formatAmbientVector formatResult
      generateId getEmbedding getGlobalRoot graphExpandRecall
      heartbeatCard hybridSearch
      importChatGPT importClaude importCursor importEntries importGenericFile importMarkdown importVault initGlobal initStore isCardStatus isEmbeddingAvailable isHandoffOutcome
      listAuditEventsAfter listCards listMemoryConflicts listPeers listSessionEvents loadActiveTaskSnapshot loadAllEntries loadCard loadCardComments loadCardDeps loadCardRuns loadEmbeddingIndex loadFreshActiveTaskSnapshot loadHandoffById loadIndex loadLatestHandoff loadLatestHandoffForCard loadRecallEntries loadSearchEntries loadSessionDecayContext
      markRetrieved multihopSearch
      partitionLessons physicsSearch promoteToGlobal
      queryAuditEvents
      readEntry rebuildIndex reclaimExpiredCards renderAmbientSummary replaceDetectedConflicts resolveConfidence resolveConflict resultToBaseline reviewCard runFeatureEval runWatched runWatchedLine
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
      ForbiddenError
      HttpError
      LOOPBACK_HOST_HEADER
      NotFoundError
      authCreate authCreateSelf authRevoke
      bindSessionOwner bindSessionOwnerOn
      captureFailureForCaller captureSessionTexts clientIpForRateLimit compactResumeForCaller
      isCrossSite isLoopback isReservedActor
      ownerOrSubject
      preCompactForCaller promptHookContext
      saveCompactionItemsForCaller serve sessionEndHandoffForCaller",
        "./session-text": "COMPACTION_ITEM_MAX_CHARS COMPACTION_ITEM_ROW_CAP
      WORKING_STATE_CAPS
      collectHandoffEvidence collectSessionTurns compactSummaryBody
      failureReport
      lessonFromFailure
      parseCompactionItems
      scrubForSharing sessionTail
      transcriptWorkingState",
        "./store-kit": "EMBEDDING_MODEL_META_KEY
      OTHER_STORE_MARKER
      RECALL_DEFAULT_DENY_SCOPES RejectedValueError
      SECRET_TAGS StoreBusyError
      bufferToFloat32
      decodeVector
      encodeVector entryAfterOutcome
      float32ToBuffer ftsTermParts
      hasGroup
      isSharedStore
      narrowStore
      ownScopeTouches
      passesScopeFilterForRecall
      rankVectorRows rarestFtsQuery rejectionDigest replacesIndex
      sqliteStore
      tallyAmbientEntries",
        "./testing": "__resetSessionRecallHistoryHttp _resetAblationCacheForTests _resetLossAversionRatioCacheForTests _resetSessionRecallHistoryMcpForTests _resetSharedStoreCacheForTests",
      }
    `);
  });
});
