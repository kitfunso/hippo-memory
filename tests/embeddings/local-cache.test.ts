/**
 * TDD test for HIPPO_MODEL_CACHE env var support.
 *
 * When HIPPO_MODEL_CACHE is set, src/embeddings.ts must configure
 * @xenova/transformers to load the model from the local directory
 * rather than downloading it from HuggingFace. This test runs offline.
 *
 * Expected: 384-dim vector produced by Xenova/all-MiniLM-L6-v2.
 *
 * Implementation note: @xenova/transformers is loaded via `new Function` in
 * src/embeddings.ts to bypass TypeScript's static module resolution. That
 * technique fails inside vitest's VM sandbox (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
 * We therefore run the actual embedding call in a child Node.js process that
 * executes outside the VM, and assert on the JSON result.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const MODEL_CACHE = path.join(REPO_ROOT, 'benchmarks/longmemeval/data/model-cache');

// This is an integration test, not a pure unit test: it shells out to the
// compiled dist/embeddings.js and loads a vendored model from
// HIPPO_MODEL_CACHE. Neither is available in a clean CI checkout — `npm test`
// does not run `npm run build`, and the model cache under
// benchmarks/longmemeval/data/model-cache/ is gitignored (vendored weights).
// When those prerequisites are absent the test skips rather than failing, so
// the default `npm test` stays reliably green; it runs in full for a developer
// who has run `npm run build` and vendored the Xenova/all-MiniLM-L6-v2 weights.
const DIST_EMBEDDINGS = path.join(REPO_ROOT, 'dist/embeddings.js');
const MINILM_DIR = path.join(MODEL_CACHE, 'Xenova/all-MiniLM-L6-v2');
const prereqsMet = existsSync(DIST_EMBEDDINGS) && existsSync(MINILM_DIR);

describe('local-cache: HIPPO_MODEL_CACHE', () => {
  it.skipIf(!prereqsMet)('produces a 384-dim embedding vector without network access', () => {
    // Build a tiny Node.js script that exercises getEmbedding() directly.
    // We use dist/embeddings.js (compiled output) so the regular import()
    // call works outside vitest's VM context.
    const script = `
import { getEmbedding } from '${REPO_ROOT}/dist/embeddings.js';
const vector = await getEmbedding('hello world');
process.stdout.write(JSON.stringify({ length: vector.length, first3: vector.slice(0, 3) }));
`;

    const result = execFileSync(process.execPath, ['--input-type=module'], {
      input: script,
      env: {
        ...process.env,
        HIPPO_MODEL_CACHE: MODEL_CACHE,
      },
      timeout: 60_000,
      cwd: REPO_ROOT,
    });

    const parsed = JSON.parse(result.toString()) as { length: number; first3: number[] };

    expect(parsed.length).toBe(384);

    // Spot-check: values should be floats in [-1, 1] (model normalises output).
    for (const v of parsed.first3) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  }, 90_000); // allow up to 90 s for first model load + child process overhead
});
