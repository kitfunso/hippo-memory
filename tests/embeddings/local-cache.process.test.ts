import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');
const MODEL_CACHE =
  process.env.HIPPO_TEST_MODEL_CACHE || path.join(REPO_ROOT, 'benchmarks/longmemeval/data/model-cache');
const DIST_EMBEDDINGS = path.join(REPO_ROOT, 'dist/infra/local-embedder.js');
const MINILM_DIR = path.join(MODEL_CACHE, 'Xenova/all-MiniLM-L6-v2');

describe('local-cache: HIPPO_MODEL_CACHE', () => {
  it('produces a 384-dim embedding vector without network access', (ctx) => {
    if (!process.env.HIPPO_REQUIRE_MODEL_CACHE && !(existsSync(DIST_EMBEDDINGS) && existsSync(MINILM_DIR))) ctx.skip();
    expect(existsSync(MINILM_DIR)).toBe(true);

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

    for (const v of parsed.first3) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  }, 90_000);
});
