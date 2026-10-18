import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { envReadLines, findEnvImports, findEnvReads } from '../../scripts/check-env-reads.mjs';

describe('check-env-reads', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-reads-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('flags dot, bracket, optional-chain and destructuring access, and skips comments', () => {
    const text = [
      'const a = process.env.HIPPO_X;',
      "const b = process['env'];",
      '// process.env.IN_A_COMMENT',
      'const c = process?.env;',
      'const { env } = process;',
      '/* process.env in a block */ const url = "https://example.com";',
    ].join('\n');
    expect(envReadLines(text)).toEqual([1, 2, 4, 5]);
  });

  it('reports files outside the allow-list with their lines', () => {
    file('env.ts', 'export const x = process.env.A;\n');
    file('sub/b.ts', 'import { x } from "../env.js";\nexport const y = process.env.B ?? x;\n');
    file('c.ts', 'export const z = 1;\n');
    expect(findEnvReads(dir, { 'env.ts': 'accessor module' })).toEqual([{ file: 'sub/b.ts', line: 2 }]);
  });

  it('flags a util/env import outside the roots and adapters, typed, dynamic or tenant-only', () => {
    file('util/env.ts', 'export const envX = () => 1;\n');
    file('cli/verb.ts', "import { envX } from '../util/env.js';\n");
    file('rerankers/a.ts', "import { envX } from '../util/env.js';\n");
    file('core/flag.ts', "import { envX } from '../util/env.js';\n");
    file('core/typed.ts', "export {};\nimport type { EnvShape } from '../util/env.js';\n");
    file('api/lazy.ts', "export async function f() {\n  return import('../util/env.js');\n}\n");
    file('store/tenant-only.ts', "import { envTenant } from '../util/env.js';\n");
    file('server/tenant.ts', "import { envTenant } from '../util/env.js';\n");
    file('core/other-env.ts', "import { x } from './env.js';\n");
    expect(findEnvImports(dir)).toEqual([
      { file: 'api/lazy.ts', line: 2 },
      { file: 'core/flag.ts', line: 1 },
      { file: 'core/typed.ts', line: 2 },
      { file: 'store/tenant-only.ts', line: 1 },
    ]);
  });

  it('src has no util/env import outside the roots and adapters', () => {
    expect(findEnvImports(join(import.meta.dirname, '..', '..', 'src'))).toEqual([]);
  });
});
