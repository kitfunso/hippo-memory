/** src/base/util/env.ts readers: timeouts refuse negatives, HIPPO_REQUIRE_SERVER reads like the other switches, ids and keys come back trimmed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  envClaudeCodeSessionId,
  envHealthProbeMs,
  envHippoSessionId,
  envLlmRerankerTimeoutMs,
  envMcpSseHeartbeatMs,
  envMcpSseMaxAgeSec,
  envModelCache,
  envRequireServer,
  envRuntimeSettings,
  envTypesafeApiKey,
} from '../../src/base/util/env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('timeouts', () => {
  const readers: Array<[string, () => number | undefined]> = [
    ['MCP_SSE_HEARTBEAT_MS', envMcpSseHeartbeatMs],
    ['MCP_SSE_MAX_AGE_SEC', envMcpSseMaxAgeSec],
    ['HIPPO_LLM_RERANKER_TIMEOUT_MS', envLlmRerankerTimeoutMs],
    ['HIPPO_HEALTH_PROBE_MS', envHealthProbeMs],
    ['HIPPO_QUERY_EMBED_TIMEOUT_MS', () => envRuntimeSettings().queryEmbedTimeoutMs],
  ];
  it.each(readers)('%s drops a negative or zero value so the caller default applies', (name, read) => {
    for (const bad of ['-5', '0', 'soon', '']) {
      vi.stubEnv(name, bad);
      expect(read(), `${name}=${bad}`).toBeUndefined();
    }
    vi.stubEnv(name, '250');
    expect(read()).toBe(250);
  });
});

describe('HIPPO_REQUIRE_SERVER', () => {
  it('is on for 1 and true, off for 0, false and unset', () => {
    for (const [value, on] of [
      ['1', true],
      ['true', true],
      ['0', false],
      ['false', false],
      ['', false],
    ] as const) {
      vi.stubEnv('HIPPO_REQUIRE_SERVER', value);
      expect(envRequireServer(), `HIPPO_REQUIRE_SERVER=${value}`).toBe(on);
    }
    vi.stubEnv('HIPPO_REQUIRE_SERVER', undefined);
    expect(envRequireServer()).toBe(false);
  });
});

describe('HIPPO_ANCHORING and HIPPO_AVAILABILITY', () => {
  it.each([
    ['HIPPO_ANCHORING', () => envRuntimeSettings().anchoringHint === false],
    ['HIPPO_AVAILABILITY', () => envRuntimeSettings().availabilityHint === false],
  ] as const)('%s switches the hint off only for an off spelling', (name, off) => {
    vi.stubEnv(name, undefined);
    expect(off()).toBe(false);
    for (const v of ['', 'on', '1', 'maybe']) {
      vi.stubEnv(name, v);
      expect(off(), `${name}=${v}`).toBe(false);
    }
    for (const v of ['off', 'OFF', '0', 'false']) {
      vi.stubEnv(name, v);
      expect(off(), `${name}=${v}`).toBe(true);
    }
  });
});

describe('trimmed readers', () => {
  const readers: Array<[string, () => string | undefined]> = [
    ['HIPPO_SESSION_ID', envHippoSessionId],
    ['CLAUDE_CODE_SESSION_ID', envClaudeCodeSessionId],
    ['HIPPO_MODEL_CACHE', envModelCache],
    ['TYPESAFE_API_KEY', envTypesafeApiKey],
  ];
  it.each(readers)('%s comes back trimmed, and blank reads as unset', (name, read) => {
    vi.stubEnv(name, '  value-1  ');
    expect(read()).toBe('value-1');
    vi.stubEnv(name, '   ');
    expect(read()).toBeUndefined();
  });
});
