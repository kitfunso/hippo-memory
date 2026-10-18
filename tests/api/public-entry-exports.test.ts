import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../../src/index.js';
import { strengthBucket } from '../../src/consolidate/dedupe.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/core/config.js';
import { initStore } from '../../src/store/sqlite/handles.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

  it('runs a Context on the hippo.db its store reads', async () => {
    const home = makeRoot('entry-sleep', { init: false });
    const origHippoHome = process.env.HIPPO_HOME;
    vi.stubEnv('HIPPO_HOME', home);
    try {
      initStore(home);
      const result = await entry.sleep(
        {
          hippoRoot: home,
          store: sqliteStore(home),
          config: loadConfig(home),
          tenantId: 'default',
          actor: { subject: 'test', role: 'admin' },
        },
        { dryRun: true },
      );
      expect(result.dryRun).toBe(true);
      expect(result.active).toBe(0);
    } finally {
      if (origHippoHome !== undefined) vi.stubEnv('HIPPO_HOME', origHippoHome);
      else vi.stubEnv('HIPPO_HOME', undefined);
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
    // The published signature takes the public Context, whose store is required; the root checks its local files.
    expect(dts).toMatch(/^export declare function sleep\(ctx: Context, opts\?: SleepOpts\): Promise<SleepResult>;$/m);
    const sleepDts = readFileSync(resolve(REPO_ROOT, 'dist', 'api', 'sleep', 'sleep.d.ts'), 'utf-8');
    // The phase-override seam lives in sleep-run.ts, so the public declaration must not name it.
    expect(sleepDts).not.toMatch(/__phases|SleepPhases/);
  });
});

/** What an eval or benchmark seeds a store with, reads it back by and scores against; the rest of the entry is reset
 * seams. */
const EVAL_KIT = [
  'ambientSecretAdmit',
  'buildIndexFromDb',
  'embedMemory',
  'initStore',
  'loadAllEntries',
  'loadEmbeddingIndex',
  'loadVectorCandidateEntriesAt',
  'recordTokenUse',
  'resolveTenantId',
  'tokensBySession',
  'upsertEntryRow',
  'writeDeliveryEventOnHandle',
  'writeEntry',
  'writeEntryDbOnly',
  'writeIndexMirror',
];

// The test seams live on their own subpath; a seam leaking back into /server or the root would ship test hooks to production callers.
describe('hippo-memory/testing', () => {
  it('resolves through the package exports map to dist/entry/testing.js and holds every test seam and the eval kit', () => {
    const script = [
      "const url = import.meta.resolve('hippo-memory/testing');",
      "const m = await import('hippo-memory/testing');",
      "const server = await import('hippo-memory/server');",
      'console.log(JSON.stringify({ url, names: Object.keys(m).sort(), onServer: Object.keys(server).some((n) => /^_+reset|ForTests$/.test(n)) }));',
    ].join('\n');
    const out = importBuiltEntry<{ url: string; names: string[]; onServer: boolean }>(script);
    expect(realpathSync(fileURLToPath(out.url))).toBe(realpathSync(resolve(REPO_ROOT, 'dist', 'entry', 'testing.js')));
    // The seam name rule of scripts/check-test-only-exports.mjs, which also admits a reader or a setter.
    const seams = out.names.filter((n) => !EVAL_KIT.includes(n));
    expect(seams.every((n) => /^_[a-z][A-Za-z0-9]*ForTests$/.test(n) || n === '__resetSessionRecallHistoryHttp')).toBe(
      true,
    );
    expect(out.names).toEqual(expect.arrayContaining(EVAL_KIT));
    expect(out.names).toContain('__resetSessionRecallHistoryHttp');
    expect(out.onServer).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'dist', 'entry', 'testing.d.ts'))).toBe(true);
  });
});

/** The module of each runtime re-export in `source`: a bare `export *` or an `export { ... }` naming at least one value. */
function runtimeReexports(source: string): string[] {
  const modules: string[] = [];
  for (const m of source.matchAll(/^export\s+(type\s+)?(\*(?:\s+as\s+\w+)?|\{([^}]*)\})\s+from\s+'([^']+)'/gm)) {
    const [, typeOnly, , names, module] = m;
    const hasValue =
      names === undefined || names.split(',').some((n) => n.trim() !== '' && !n.trim().startsWith('type '));
    if (!typeOnly && hasValue) modules.push(module);
  }
  return modules;
}

// A root export of a ./store/ or ./db/ function hands add-ons a folder-taking call that skips the tenant, actor and audit checks every api function applies.
describe('package root', () => {
  it('re-exports no value from a ./store/ or ./db/ module', () => {
    const modules = runtimeReexports(readFileSync(resolve(REPO_ROOT, 'src', 'index.ts'), 'utf-8'));
    // src/index.ts, not this test, sets the list; these two prove the scan reads a multi-line block and a mixed line.
    expect(modules).toEqual(expect.arrayContaining(['./core/card.js', './graph/recall.js']));
    expect(modules.filter((module) => /^\.\/(store|db)\//.test(module))).toEqual([]);
  });

  it('sees a value re-export and ignores a type-only one', () => {
    const source = [
      "export { a, type B } from './store/x.js';",
      "export type { C } from './store/y.js';",
      "export { type D } from './db/z.js';",
      "export * from './db/all.js';",
    ].join('\n');
    expect(runtimeReexports(source)).toEqual(['./store/x.js', './db/all.js']);
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
    expect(Object.fromEntries(Object.entries(names).map(([subpath, list]) => [subpath, byInitial(list)])))
      .toMatchInlineSnapshot(`
      {
        ".": "CARD_LEASE_MS CARD_TRANSITIONS
      DEFAULT_MAX_NEIGHBORS
      Layer
      MAX_HOPS
      applyOutcome
      buildSyntheticCorpus
      calculateStrength captureError computeAmbientState computeSalience computeSchemaFit computeTemporalRange confidenceFacets consolidate createMemory
      detectRegressions detectTemporalDirection
      estimateTokens explainMatch extractLessons
      formatAmbientVector formatResult
      generateId getEmbedding getGlobalRoot graphExpandRecall
      hybridSearch
      importChatGPT importClaude importCursor importEntries importGenericFile importMarkdown importVault isCardStatus isEmbeddingAvailable isHandoffOutcome
      markRetrieved multihopSearch
      partitionLessons
      renderAmbientSummary resolveConfidence resultToBaseline runFeatureEval
      search sleep strengthBucket
      temporalBoost textOverlap tokenize transferScore",
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
      PROTECTED_ROWS
      RECALL_DEFAULT_DENY_SCOPES RejectedValueError
      SECRET_TAGS StoreBusyError
      ambientRefusal
      bufferToFloat32
      decodeVector descendantAdmits
      encodeVector entryAfterOutcome
      float32ToBuffer ftsTermParts
      hasGroup heldTexts
      isSharedStore
      loadConfig
      normalizeValueForRejection
      ownScopeTouches
      passesScopeFilterForRecall physicsSearch
      rankVectorRows rarestFtsQuery rejectionDigest repairKeeps replacesIndex requireGroup
      sqliteStore
      tallyAmbientEntries",
        "./testing": "__resetSessionRecallHistoryHttp _readApiKeyVerifyStatsForTests _resetAblationCacheForTests _resetLogOnceForTests _resetLossAversionRatioCacheForTests _resetProjectIdentityCacheForTests _resetSessionRecallHistoryMcpForTests _resetSharedStoreCacheForTests _setDigestExistsProbeForTests
      ambientSecretAdmit
      buildIndexFromDb
      embedMemory
      initStore
      loadAllEntries loadEmbeddingIndex loadVectorCandidateEntriesAt
      recordTokenUse resolveTenantId
      tokensBySession
      upsertEntryRow
      writeDeliveryEventOnHandle writeEntry writeEntryDbOnly writeIndexMirror",
      }
    `);
  });
});
