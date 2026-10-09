import { configDefaults, defineConfig } from 'vitest/config';
import base, { EVAL_TESTS } from './vitest.config.ts';

// The slow token-eval harness tests run in token-eval.yml, beside ci.yml's shards; importing base keeps its isolated homes and blank keys.
// Every one of them spawns, so they run as one set at the process timeout and not through base's two projects.
export default defineConfig({ ...base, test: { ...base.test, projects: undefined, include: EVAL_TESTS, exclude: configDefaults.exclude, testTimeout: 30_000, hookTimeout: 30_000 } });
