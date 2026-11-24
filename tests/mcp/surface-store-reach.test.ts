import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'src');

function tsFilesUnder(dir: string): string[] {
  return readdirSync(join(SRC, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f.replaceAll('\\', '/')}`);
}

function linesMatching(files: readonly string[], re: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .flatMap((line, i) => (re.test(line) ? [`${file}:${i + 1}`] : [])),
  );
}

describe('surface reach into the store', () => {
  it('no src/surface/mcp file imports the SQLite adapter', () => {
    expect(linesMatching(tsFilesUnder('surface/mcp'), /['"](\.\.\/)+store\/sqlite\//)).toEqual([]);
  });

  it('the memory routes import nothing from src/store and decide no store capability', () => {
    expect(linesMatching(['surface/server/routes/memories.ts'], /['"](\.\.\/)+store\/|\bhasGroup\b/)).toEqual([]);
  });
});
