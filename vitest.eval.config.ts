import { configDefaults, defineConfig } from 'vitest/config';
import base, { EVAL_TESTS } from './vitest.config.ts';
const CODEX = EVAL_TESTS.filter((file) => file.includes('-z0-codex-'));
const project = (name: string, include: string[]) => ({ extends: true, test: { name, include, exclude: configDefaults.exclude } });
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: [project('harness', EVAL_TESTS.filter((file) => !CODEX.includes(file))), project('codex', CODEX)],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
