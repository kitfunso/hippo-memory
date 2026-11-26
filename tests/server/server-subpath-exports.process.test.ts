import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runModuleScript } from '../_helpers/run-module-script.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SERVER_VALUES = [
  'admitProjectWrite',
  'authCreate',
  'authCreateSelf',
  'authRevoke',
  'bindSessionOwner',
  'captureFailureForCaller',
  'captureSessionTexts',
  'clientIpForRateLimit',
  'compactResumeForCaller',
  'embedAll',
  'folderIndex',
  'GROUPS_CLAIM_TOO_LONG',
  'isCrossSite',
  'isLoopback',
  'isReservedActor',
  'LOOPBACK_HOST_HEADER',
  'NO_MAPPED_GROUP',
  'ownerOrSubject',
  'preCompactForCaller',
  'promptHookContext',
  'roleFromGroups',
  'runConnectorCommand',
  'saveCompactionItemsForCaller',
  'serve',
  'sessionEndHandoffForCaller',
  'VIEWER_REFUSAL',
  'BadRequestError',
  'ConflictError',
  'ForbiddenError',
  'HttpError',
  'NotFoundError',
];
const SERVER_TYPES = [
  'Actor',
  'AddonCall',
  'AddonRoute',
  'AuthCreateOptions',
  'AuthCreateResult',
  'AuthCreateSelfOptions',
  'AuthCreateSelfResult',
  'AuthResolver',
  'AuthRevokeResult',
  'CallerCompactResumeRequest',
  'CallerEvidence',
  'CallerFailureRequest',
  'CallerFailureResult',
  'CallerHookOutput',
  'CallerItemsRequest',
  'CallerItemsResult',
  'CallerPreCompactRequest',
  'CallerProject',
  'CallerSessionEndRequest',
  'CallerSessionEndResult',
  'CaptureContext',
  'ConnectorCommandContext',
  'Context',
  'DetachedWork',
  'HippoStore',
  'JsonValue',
  'KeyQuota',
  'KeyQuotaCall',
  'KeyQuotaRefusal',
  'OAuthResource',
  'ProjectWriteCall',
  'ProjectWriteGate',
  'RateLimitSpec',
  'ResolvedBearer',
  'Role',
  'RoleFromGroups',
  'RoleGroups',
  'RoleLevel',
  'ServeOptions',
  'ServerHandle',
  'SessionCaptureRequest',
  'SessionCaptureResult',
  'WorkingState',
];
const STORE_KIT_VALUES = [
  'ALL_TENANTS',
  'ambientRefusal',
  'assertWriteRight',
  'auditRowsRead',
  'bufferToFloat32',
  'canReadScope',
  'cjkIndexTerms',
  'decodeVector',
  'descendantAdmits',
  'diffGraph',
  'duplicateHash',
  'EMBEDDING_MODEL_META_KEY',
  'encodeVector',
  'entryAfterOutcome',
  'float32ToBuffer',
  'ftsTermParts',
  'GRAPH_ID_BATCH',
  'hasGroup',
  'heldTexts',
  'identityText',
  'initStore',
  'interleaveRows',
  'isoInstant',
  'isSharedStore',
  'LIKE_WINDOW_ROWS',
  'LIKE_WINDOW_TERMS',
  'loadConfig',
  'normalizeValueForRejection',
  'OPTIONAL_GROUPS',
  'OTHER_STORE_MARKER',
  'ownScopeTouches',
  'partitionCjkTerms',
  'passesScopeFilterForRecall',
  'physicsSearch',
  'PROTECTED_ROWS',
  'rankVectorRows',
  'rarestFtsQuery',
  'RawAppendOnlyError',
  'readerMayChange',
  'readerReaches',
  'repairKeeps',
  'RECALL_DEFAULT_DENY_SCOPES',
  'RECALL_ONLY_TAGS',
  'RejectedValueError',
  'rejectionDigest',
  'replacesIndex',
  'requireGroup',
  'rowDigests',
  'runStoreConformance',
  'SCHEMA_FIT_WINDOW_ROWS',
  'SECRET_TAGS',
  'sortableStamp',
  'splitLikeTerms',
  'sqliteStore',
  'StoreBusyError',
  'tallyAmbientEntries',
  'targetReader',
  'tombstoneDigest',
];
const STORE_KIT_TYPES = [
  'ActiveGoals',
  'AmbientAdmission',
  'AmbientCandidateRequest',
  'AmbientCandidates',
  'AmbientLoadResult',
  'AmbientRefusal',
  'AmbientRefusalReason',
  'DescendantAdmission',
  'AmbientRecallRequest',
  'AmbientStoreFilter',
  'AmbientTallies',
  'ApiKeyListItem',
  'ApiKeyListRow',
  'ApiKeyRecord',
  'AppendAuditOptions',
  'AuditEvent',
  'ClassResolution',
  'ContextCandidateFilter',
  'ContextReads',
  'ContinuityBlock',
  'ContinuityKey',
  'EmbeddingIndexState',
  'EntryRemoval',
  'EntryTarget',
  'EntryWrite',
  'EntryWrites',
  'GetActiveGoalsOptions',
  'Goal',
  'GoalRecallLogRow',
  'HippoStore',
  'KeyListQuery',
  'KeyMint',
  'KeyRevoke',
  'KeysetPosition',
  'KeyWrites',
  'LastRecall',
  'LastRecallWrites',
  'ListApiKeysOptions',
  'MemoryEntry',
  'NewApiKey',
  'OptionalGroup',
  'ConformanceRunner',
  'RequiredStore',
  'OriginFilter',
  'OutcomeWrite',
  'PhysicsParticle',
  'PlanningFallacyEvidence',
  'PredictionBaserate',
  'RawArchive',
  'RecallScopeFilter',
  'RecallSearchArgs',
  'RecallTraceInput',
  'RecallWrites',
  'RecentOrigins',
  'RetrievalPolicy',
  'ScopeActor',
  'ScopeReader',
  'SelfKeyMint',
  'SessionEvent',
  'SessionHandoff',
  'StoreGroup',
  'StoreGroups',
  'StoredGraph',
  'StoredPart',
  'StoredParts',
  'StrengthenOptions',
  'SupersedeWrite',
  'TaskSnapshot',
  'TenantId',
  'TokenUse',
  'VectorBackfillQuery',
  'VectorCandidateSpec',
  'VectorMatch',
  'VectorReads',
  'VectorRow',
  'VectorRowWrite',
  'VectorWrite',
  'VectorWriteResult',
  'VectorWrites',
  // The session and admin groups (store-groups.ts).
  'Card',
  'CardComment',
  'CardCreate',
  'CardDetail',
  'CardRun',
  'CardStatus',
  'Cards',
  'CompleteGoalOptions',
  'ConflictListQuery',
  'ConflictMember',
  'ConflictResolution',
  'ConflictRow',
  'ConflictRowPage',
  'ConflictSide',
  'LoserFate',
  'Conflicts',
  'Dormant',
  'DormantMemory',
  'DormantRestoreOutcome',
  'DormantRestoreRequest',
  'DormantSnapshot',
  'EntryCursor',
  'EntryPage',
  'FailureSummary',
  'Goals',
  'HandoffFilter',
  'HandoffOutcome',
  'ListDormantOptions',
  'MemoryConflict',
  'PushGoalOptions',
  'Reports',
  'SessionEndHandoffRequest',
  'SessionEventInput',
  'Sessions',
  'SnapshotInput',
  'StrengthTallies',
  'TokenSummary',
  'WorkingMemoryFilter',
  'WorkingMemoryItem',
  'WorkingMemoryPush',
  'WrittenRow',
  'AppliedRejection',
  'LiftedRejection',
  'Rejection',
  'RejectionCheck',
  'Rejections',
  'RejectionSource',
  'RejectedValueRow',
  'FailureEvent',
  'FailureLog',
  'FailureOutcome',
  'LegacyStats',
  'StatusCounts',
  'CorrectionLink',
  'RawProvenance',
  'EntryFilter',
  'PageRequest',
  'RepairProtection',
  'HippoConfig',
  'CallerItems',
  'CallerItemsSaved',
  'CompactionStart',
  'Compactions',
];

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** Runtime names of each built subpath, imported by package name from a child so the exports map is what resolves. */
function runtimeNames(): Record<string, string[]> {
  const script = [
    'const names = {};',
    "for (const sub of ['server', 'store-kit']) names[sub] = Object.keys(await import('hippo-memory/' + sub));",
    'console.log(JSON.stringify(names));',
  ].join('\n');
  return runModuleScript<Record<string, string[]>>(script);
}

/** Every name the built .d.ts file exports, type-only ones included. */
function declaredNames(dtsPath: string): string[] {
  const text = readFileSync(resolve(root, dtsPath), 'utf-8');
  const names: string[] = [];
  for (const block of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const item of block[1]!.split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop();
      if (name) names.push(name);
    }
  }
  for (const decl of text.matchAll(/^export declare (?:function|const|class) (\w+)/gm)) names.push(decl[1]!);
  return names;
}

describe('hippo-memory/server and hippo-memory/store-kit published exports', () => {
  it('server exports only the add-on API and store-kit exports the store-implementer contract', () => {
    const names = runtimeNames();
    expect(sorted(names['server']!)).toEqual(sorted(SERVER_VALUES));
    expect(sorted(names['store-kit']!)).toEqual(sorted(STORE_KIT_VALUES));
  });

  it('keeps no store-kit value on server', () => {
    const names = runtimeNames();
    expect(names['server']!.filter((n) => STORE_KIT_VALUES.includes(n))).toEqual([]);
  });

  it('declares the same names in the built .d.ts files, types included', () => {
    expect(sorted(declaredNames('dist/server.d.ts'))).toEqual(sorted([...SERVER_VALUES, ...SERVER_TYPES]));
    expect(sorted(declaredNames('dist/entry/store-kit.d.ts'))).toEqual(
      sorted([...STORE_KIT_VALUES, ...STORE_KIT_TYPES]),
    );
  });

  it('still exports isCrossSite, LOOPBACK_HOST_HEADER and authCreate from the published subpath', () => {
    const script = [
      "const { isCrossSite, LOOPBACK_HOST_HEADER, authCreate } = await import('hippo-memory/server');",
      'const req = (headers) => ({ headers });',
      'console.log(JSON.stringify({',
      "  localHost: LOOPBACK_HOST_HEADER.test('127.0.0.1:3333'),",
      "  rebound: LOOPBACK_HOST_HEADER.test('evil.example:3333'),",
      "  crossSite: isCrossSite(req({ 'sec-fetch-site': 'cross-site' })),",
      "  sameOrigin: isCrossSite(req({ 'sec-fetch-site': 'same-origin', host: 'localhost:3333', origin: 'http://localhost:3333' })),",
      "  foreignOrigin: isCrossSite(req({ host: 'localhost:3333', origin: 'http://evil.example' })),",
      '  cli: isCrossSite(req({})),',
      '  authCreate: typeof authCreate,',
      '}));',
    ].join('\n');
    const out = runModuleScript<Record<string, boolean | string>>(script);
    expect(out).toEqual({
      localHost: true,
      rebound: false,
      crossSite: true,
      sameOrigin: false,
      foreignOrigin: true,
      cli: false,
      authCreate: 'function',
    });
  });

  it('runs a connector verb on a store opened through store-kit, with no exit code set', () => {
    const script = [
      "import { mkdtempSync, rmSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      "const { runConnectorCommand } = await import('hippo-memory/server');",
      "const { sqliteStore, initStore, loadConfig } = await import('hippo-memory/store-kit');",
      "const root = mkdtempSync(join(tmpdir(), 'hippo-run-connector-'));",
      'initStore(root);',
      'const store = sqliteStore(root);',
      'const ctx = { tenantId: "default", store, config: loadConfig(root) };',
      'const lines = [];',
      'const log = console.log;',
      "console.log = (...args) => lines.push(args.join(' '));",
      "const slack = await runConnectorCommand(ctx, ['slack', 'dlq', 'list']);",
      'const slackLines = lines.splice(0);',
      "const github = await runConnectorCommand(ctx, ['github', 'dlq', 'list']);",
      'console.log = log;',
      'await store.close();',
      'rmSync(root, { recursive: true, force: true, maxRetries: 5 });',
      'console.log(JSON.stringify({ slack, slackLines, github, githubLines: lines, exitCode: process.exitCode ?? null }));',
    ].join('\n');
    const out = runModuleScript<{
      slack: number;
      slackLines: string[];
      github: number;
      githubLines: string[];
      exitCode: number | null;
    }>(script);
    expect(out).toEqual({ slack: 0, slackLines: [], github: 0, githubLines: ['no entries'], exitCode: null });
  });
});
