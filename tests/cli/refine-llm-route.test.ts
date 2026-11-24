import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { runCli as runCliEntry } from '../../src/cli.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';
import { removeDir } from '../_helpers/remove-dir.js';

const savedCwd = process.cwd();
let home = '';

const refine = (): Promise<InProcessResult> => runInProcess(() => runCliEntry(['node', 'hippo', 'refine']));

beforeEach(() => {
  home = makeStore('refine-route').base;
  vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_TENANT', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  process.chdir(home);
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeDir(home);
});

describe('hippo refine model selection', () => {
  it('exits 1 naming HIPPO_LLM_MODEL when the base URL has no model, with no call', async () => {
    vi.stubEnv('HIPPO_LLM_BASE_URL', 'http://127.0.0.1:9/v1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'));
    const res = await refine();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('hippo refine: HIPPO_LLM_MODEL is required when HIPPO_LLM_BASE_URL is set');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exits 1 naming both routes when no model is set', async () => {
    const res = await refine();
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('HIPPO_LLM_BASE_URL');
    expect(res.stderr).toContain('ANTHROPIC_API_KEY');
  });
});
