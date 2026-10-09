// Error text for a caught value has one definition, errorMessage() in src/util/log.ts; an inline copy drifts from it.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve('src');
const IDENT = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
const INLINE = new RegExp(String.raw`(${IDENT})\s+instanceof\s+Error\s*\?\s*\1\.message\s*:\s*String\(\s*\1\s*\)`, 'g');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(full);
    return d.name.endsWith('.ts') ? [full] : [];
  });
}

describe('error text helper', () => {
  it('no file in src spells out the instanceof Error ternary outside src/util/log.ts', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (path.relative(SRC, file).split(path.sep).join('/') === 'util/log.ts') continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(INLINE)) {
        const line = source.slice(0, match.index).split('\n').length;
        hits.push(`${path.relative(SRC, file)}:${line}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
