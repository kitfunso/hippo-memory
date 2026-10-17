// Test seams for add-ons and hippo's own suite. Not for production code; no semver guarantee beyond the major version.
export { _resetAblationCacheForTests } from '../core/ablation.js';
export { _setDigestExistsProbeForTests } from '../capture/session-digest.js';
export { _resetSharedStoreCacheForTests } from '../core/config.js';
export { _resetLossAversionRatioCacheForTests } from '../core/memory.js';
export { _resetProjectIdentityCacheForTests } from '../core/project-identity.js';
export { _resetSessionRecallHistoryMcpForTests } from '../mcp/session-state.js';
export { __resetSessionRecallHistoryHttp } from '../server/routes/recall.js';
export { _readApiKeyVerifyStatsForTests } from '../store/auth.js';
export { _resetLogOnceForTests } from '../util/log.js';
