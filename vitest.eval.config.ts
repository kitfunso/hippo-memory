import { configDefaults, defineConfig } from 'vitest/config';
import base, { EVAL_TESTS } from './vitest.config.ts';

// The token-eval harness tests run in token-eval.yml, off the per-PR suite; importing base keeps its isolated homes and blank keys.
export default defineConfig({ ...base, test: { ...base.test, include: EVAL_TESTS, exclude: configDefaults.exclude } });
