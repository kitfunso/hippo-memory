// E10 lane A: the default-deny SQL lives in scopeAdmitSql alone, so a new read site cannot hand-roll a clause that drops the owner arm.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const HAND_ROLLED = /:private:%|['"`]unknown:legacy['"`]/;
const ALLOWED = new Set(['recall-scope.ts']);
// Migrations stamp the legacy marker once, as data, and never read through it.
const EXEMPT_DIR = `db${sep}migrations${sep}`;

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function hits(file: string): string[] {
  return readFileSync(join(SRC, file), 'utf8').split(/\r?\n/)
    .flatMap((line, i) => (!isComment(line) && HAND_ROLLED.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []));
}

const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));

describe('scope SQL guard (E10 lane A)', () => {
  it('finds the patterns where they belong, so the scan is live', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(hits('recall-scope.ts').length).toBeGreaterThan(0);
  });

  it('no other source file spells the default-deny SQL or the legacy marker', () => {
    const offenders = sources
      .filter((f) => !ALLOWED.has(f) && !f.startsWith(EXEMPT_DIR))
      .flatMap(hits);
    expect(offenders).toEqual([]);
  });
});
