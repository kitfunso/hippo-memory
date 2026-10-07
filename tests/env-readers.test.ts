/** src/env.ts readers: timeouts refuse negatives, HIPPO_REQUIRE_SERVER reads like the other switches, ids and keys come back trimmed. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  envClaudeCodeSessionId,
  envHippoSessionId,
  envLlmRerankerTimeoutMs,
  envMcpSseHeartbeatMs,
  envMcpSseMaxAgeSec,
  envModelCache,
  envRequireServer,
  envTypesafeApiKey,
} from '../src/env.js';

const NAMES = [
  'MCP_SSE_HEARTBEAT_MS', 'MCP_SSE_MAX_AGE_SEC', 'HIPPO_LLM_RERANKER_TIMEOUT_MS', 'HIPPO_REQUIRE_SERVER',
  'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_MODEL_CACHE', 'TYPESAFE_API_KEY',
];
const saved = new Map(NAMES.map((n) => [n, process.env[n]]));
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('timeouts', () => {
  const readers: Array<[string, () => number | undefined]> = [
    ['MCP_SSE_HEARTBEAT_MS', envMcpSseHeartbeatMs],
    ['MCP_SSE_MAX_AGE_SEC', envMcpSseMaxAgeSec],
    ['HIPPO_LLM_RERANKER_TIMEOUT_MS', envLlmRerankerTimeoutMs],
  ];
  it.each(readers)('%s drops a negative or zero value so the caller default applies', (name, read) => {
    for (const bad of ['-5', '0', 'soon', '']) {
      process.env[name] = bad;
      expect(read(), `${name}=${bad}`).toBeUndefined();
    }
    process.env[name] = '250';
    expect(read()).toBe(250);
  });
});

describe('HIPPO_REQUIRE_SERVER', () => {
  it('is on for 1 and true, off for 0, false and unset', () => {
    for (const [value, on] of [['1', true], ['true', true], ['0', false], ['false', false], ['', false]] as const) {
      process.env.HIPPO_REQUIRE_SERVER = value;
      expect(envRequireServer(), `HIPPO_REQUIRE_SERVER=${value}`).toBe(on);
    }
    delete process.env.HIPPO_REQUIRE_SERVER;
    expect(envRequireServer()).toBe(false);
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
    process.env[name] = '  value-1  ';
    expect(read()).toBe('value-1');
    process.env[name] = '   ';
    expect(read()).toBeUndefined();
  });
});
