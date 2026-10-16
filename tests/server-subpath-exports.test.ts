import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SERVER_VALUES = [
  'authCreate', 'authCreateSelf', 'authRevoke', 'bindSessionOwner', 'bindSessionOwnerOn', 'captureFailureForCaller', 'captureSessionTexts',
  'clientIpForRateLimit', 'compactResumeForCaller', 'isCrossSite', 'isLoopback', 'isReservedActor', 'LOOPBACK_HOST_HEADER',
  'ownerOrSubject', 'preCompactForCaller', 'promptHookContext', 'saveCompactionItemsForCaller', 'serve', 'sessionEndHandoffForCaller',
  'BadRequestError', 'ConflictError', 'ForbiddenError', 'HttpError', 'NotFoundError',
];
const SERVER_TYPES = [
  'Actor', 'AddonCall', 'AddonRoute', 'AuthCreateOpts', 'AuthCreateResult', 'AuthCreateSelfOpts', 'AuthCreateSelfResult', 'AuthResolver',
  'AuthRevokeResult', 'CallerCompactResumeRequest', 'CallerEvidence', 'CallerFailureRequest', 'CallerFailureResult', 'CallerHookOutput',
  'CallerItemsRequest', 'CallerItemsResult', 'CallerPreCompactRequest', 'CallerProject', 'CallerSessionEndRequest', 'CallerSessionEndResult',
  'Context', 'HippoStore', 'JsonValue', 'RateLimitSpec', 'ResolvedBearer', 'ServeOpts', 'ServerHandle', 'SessionCaptureRequest',
  'SessionCaptureResult', 'WorkingState',
];
const STORE_KIT_VALUES = [
  'bufferToFloat32', 'decodeVector', 'EMBEDDING_MODEL_META_KEY', 'encodeVector', 'entryAfterOutcome', 'float32ToBuffer', 'ftsTermParts',
  'hasGroup', 'isSharedStore', 'OTHER_STORE_MARKER', 'ownScopeTouches', 'passesScopeFilterForRecall', 'physicsSearch', 'rankVectorRows', 'rarestFtsQuery',
  'RECALL_DEFAULT_DENY_SCOPES', 'RejectedValueError', 'rejectionDigest', 'replacesIndex', 'requireGroup', 'SECRET_TAGS', 'sqliteStore', 'StoreBusyError',
  'tallyAmbientEntries',
];
const STORE_KIT_TYPES = [
  'ActiveGoals', 'AmbientCandidateRequest', 'AmbientLoadResult', 'AmbientRecallRequest', 'AmbientStoreFilter', 'AmbientTallies',
  'ApiKeyListItem', 'ApiKeyListRow', 'ApiKeyRecord', 'AppendAuditOpts', 'AuditEvent', 'ClassResolution', 'ContextCandidateFilter',
  'ContextReads', 'ContinuityBlock', 'ContinuityKey', 'EmbeddingIndexState', 'EntryRemoval', 'EntryTarget', 'EntryWrite', 'EntryWrites',
  'GetActiveGoalsOpts', 'Goal', 'GoalRecallLogRow', 'HippoDbContext', 'HippoStore', 'KeyAudit', 'KeyListQuery', 'KeyMint', 'KeyRevoke',
  'KeysetPosition', 'KeyWrites', 'LastRecall', 'LastRecallWrites', 'ListApiKeysOpts', 'ListAuditAfterOpts', 'MemoryEntry', 'NewApiKey',
  'OptionalGroup', 'OriginFilter', 'OutcomeWrite', 'PhysicsParticle', 'PlanningFallacyEvidence', 'PredictionBaserate', 'RawArchive', 'RecallScopeFilter',
  'RecallSearchArgs', 'RecallTraceInput', 'RecallWrites', 'RecentOrigins', 'RetrievalPolicy', 'SelfKeyMint', 'SessionEvent', 'SessionHandoff',
  'StoreContext', 'StoreGroup', 'StoreGroups', 'StrengthenOptions', 'SupersedeWrite', 'TaskSnapshot', 'TokenUse', 'VectorBackfillQuery', 'VectorCandidateSpec',
  'VectorMatch', 'VectorReads', 'VectorRow', 'VectorRowWrite', 'VectorWrite', 'VectorWriteResult', 'VectorWrites',
  // The session and admin groups (port-groups.ts).
  'Card', 'CardComment', 'CardCreate', 'CardDetail', 'CardRun', 'CardStatus', 'Cards', 'CompleteGoalOpts',
  'Conflicts', 'Dormant', 'DormantMemory', 'DormantRestoreOutcome', 'DormantRestoreRequest', 'DormantSnapshot',
  'EntryCursor', 'EntryPage', 'FailureSummary', 'Goals', 'HandoffFilter', 'HandoffOutcome', 'ListDormantOpts',
  'MemoryConflict', 'PushGoalOpts', 'Reports', 'ResolveConflictOpts', 'ResolveConflictRequest',
  'SessionEndHandoffRequest', 'SessionEventInput', 'Sessions', 'SnapshotInput', 'StrengthTallies', 'TokenSummary',
  'WorkingMemoryFilter', 'WorkingMemoryItem', 'WorkingMemoryPush',
];

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** Runtime names of each built subpath, imported by package name from a child so the exports map is what resolves. */
function runtimeNames(): Record<string, string[]> {
  const script = [
    'const names = {};',
    "for (const sub of ['server', 'store-kit']) names[sub] = Object.keys(await import('hippo-memory/' + sub));",
    'console.log(JSON.stringify(names));',
  ].join('\n');
  // cwd is the checkout because self-reference resolves from the nearest package.json.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf-8', timeout: 30_000 });
  if (child.status !== 0) throw new Error(`self-reference import failed (run \`npm run build\` first):\n${child.stderr}`);
  const lines = child.stdout.trim().split('\n');
  // SAFETY: the child script above is the only writer of the last stdout line and always emits these keys.
  return JSON.parse(lines[lines.length - 1]!) as Record<string, string[]>;
}

/** Every name the built .d.ts file exports, type-only ones included. */
function declaredNames(dtsPath: string): string[] {
  const text = readFileSync(resolve(root, dtsPath), 'utf-8');
  const names: string[] = [];
  for (const block of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const item of block[1]!.split(',')) {
      const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop();
      if (name) names.push(name);
    }
  }
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
    expect(sorted(declaredNames('dist/entry/store-kit.d.ts'))).toEqual(sorted([...STORE_KIT_VALUES, ...STORE_KIT_TYPES]));
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
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf-8', timeout: 30_000 });
    if (child.status !== 0) throw new Error(`self-reference import failed (run \`npm run build\` first):\n${child.stderr}`);
    const lines = child.stdout.trim().split('\n');
    // SAFETY: the child script above is the only writer of the last stdout line and always emits these keys.
    const out = JSON.parse(lines[lines.length - 1]!) as Record<string, boolean | string>;
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
});
