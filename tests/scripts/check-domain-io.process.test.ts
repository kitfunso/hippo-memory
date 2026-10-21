import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { adapterReach, findDomainIo, ioImports } from '../../scripts/check-domain-io.mjs';

describe('check-domain-io', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'domain-io-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('finds fs, fs/promises and child_process with or without node:, static, re-exported or dynamic', () => {
    const text = [
      "import * as fs from 'fs';",
      "import { readFile } from 'node:fs/promises';",
      "import type { ChildProcess } from 'child_process';",
      "export { spawn } from 'node:child_process';",
      "const later = () => import('node:fs');",
      "import * as path from 'node:path';",
      "// import 'fs' in a comment",
    ].join('\n');
    expect(ioImports(text).map((i) => [i.line, i.spec])).toEqual([
      [1, 'fs'],
      [2, 'node:fs/promises'],
      [3, 'child_process'],
      [4, 'node:child_process'],
      [5, 'node:fs'],
    ]);
  });

  it('fails a domain or api import and leaves base and surface alone', () => {
    file('domain/learn/a.ts', "import { execFileSync } from 'child_process';\n");
    file('api/b.ts', "export const x = 1;\nimport * as fs from 'node:fs';\n");
    file('base/util/c.ts', "import * as fs from 'node:fs';\n");
    file('surface/cli/d.ts', "import { spawn } from 'child_process';\n");
    expect(findDomainIo(dir)).toEqual([
      { file: 'api/b.ts', line: 2, spec: 'node:fs' },
      { file: 'domain/learn/a.ts', line: 1, spec: 'child_process' },
    ]);
  });

  it('fails the file it once exempted: no exemption list exists to put one back on', () => {
    file('domain/sharing/project-merge.ts', "import * as fs from 'node:fs';\n");
    expect(findDomainIo(dir)).toEqual([{ file: 'domain/sharing/project-merge.ts', line: 1, spec: 'node:fs' }]);
  });

  it('finds a domain import of src/infra, an adapter module or function, and a fetch call', () => {
    const src = join(dir, 'src');
    const text = [
      "import { processHttp } from '../../infra/http.js';",
      "import type { EmbeddingProvider } from '../../base/embeddings/provider.js';",
      "import { fetchWithRetry as send } from '../../base/util/net-tools.js';",
      "export { importTransformers } from '../../base/model/loader.js';",
      "import type { Http } from '../../base/ports/http.js';",
      "const later = () => import('../../base/util/http-retry.js');",
      'const reply = await fetch(url);',
      'const again = await globalThis.fetch(url);',
      'const port = await http.send(url, init, policy);',
    ].join('\n');
    expect(adapterReach(text, join(src, 'domain', 'search', 'a.ts'), src)).toEqual([
      { line: 1, spec: '../../infra/http.js' },
      { line: 2, spec: '../../base/embeddings/provider.js' },
      { line: 3, spec: '../../base/util/net-tools.js' },
      { line: 4, spec: '../../base/model/loader.js' },
      { line: 6, spec: '../../base/util/http-retry.js' },
      { line: 7, spec: 'fetch()' },
      { line: 8, spec: 'globalThis.fetch()' },
    ]);
  });

  it('holds domain to its ports and leaves infra, api and surface to reach the adapters', () => {
    file('domain/rerankers/a.ts', "import { processHttp } from '../../infra/http.js';\n");
    file('domain/search/b.ts', "export const x = 1;\nconst r = await fetch('https://example.com');\n");
    file('api/c.ts', "import { getReranker } from '../infra/rerankers.js';\n");
    file('infra/d.ts', "import { fetchWithRetry } from './http-retry.js';\n");
    file('surface/e.ts', "import { resolveEmbeddingProvider } from '../infra/embedding-provider.js';\n");
    expect(findDomainIo(dir)).toEqual([
      { file: 'domain/rerankers/a.ts', line: 1, spec: '../../infra/http.js' },
      { file: 'domain/search/b.ts', line: 2, spec: 'fetch()' },
    ]);
  });

  it('passes on the real src tree', () => {
    expect(findDomainIo(resolve(__dirname, '..', '..', 'src'))).toEqual([]);
  });
});
