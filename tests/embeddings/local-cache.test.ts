// HIPPO_MODEL_CACHE makes the local embedding backend load its model from a folder, with no download.
// The embedding runs in a child process: the backend loads Transformers.js by a dynamic import that vitest's VM cannot serve.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import * as url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
// The CI job that has already fetched the weights points this at them; a developer vendors them under benchmarks/.
const MODEL_CACHE = process.env.HIPPO_MODEL_CACHE || path.join(REPO_ROOT, 'benchmarks/longmemeval/data/model-cache');
const DIST_EMBEDDINGS = path.join(REPO_ROOT, 'dist/store/embeddings/local.js');
const MINILM_DIR = path.join(MODEL_CACHE, 'Xenova/all-MiniLM-L6-v2');

describe('local-cache: HIPPO_MODEL_CACHE', () => {
  it('produces a 384-dim embedding vector without network access', (ctx) => {
    // The weights are not in a clean checkout, so this skips there; the job that has them sets the flag, and there a missing folder fails.
    if (!process.env.HIPPO_REQUIRE_MODEL_CACHE && !(existsSync(DIST_EMBEDDINGS) && existsSync(MINILM_DIR))) ctx.skip();
    expect(existsSync(MINILM_DIR)).toBe(true);

    // Build a tiny Node.js script that exercises getEmbedding() directly.
    // We use dist/store/embeddings/local.js (compiled output) so the regular import()
    // call works outside vitest's VM context.
    const script = `
import { getEmbedding } from '${url.pathToFileURL(DIST_EMBEDDINGS).href}';
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

    // SAFETY: result is this test's own script's stdout, written by the
    // process.stdout.write(JSON.stringify(...)) call in the script above.
    const parsed = JSON.parse(result.toString()) as { length: number; first3: number[] };

    expect(parsed.length).toBe(384);

    // Spot-check: values should be floats in [-1, 1] (model normalises output).
    for (const v of parsed.first3) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  }, 90_000); // allow up to 90 s for first model load + child process overhead
});
