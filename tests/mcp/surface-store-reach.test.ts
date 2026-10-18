// MCP reaches the store through src/api or the port, never the SQLite adapter. The api checks no store group, so the
// memory routes leave every capability check to the server's one edge helper (src/server/store-edge.ts).
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'src');

function tsFilesUnder(dir: string): string[] {
  return readdirSync(join(SRC, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${dir}/${f.replaceAll('\\', '/')}`);
}

/** `file:line` of each line in `files` that matches `re`. */
function linesMatching(files: readonly string[], re: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .flatMap((line, i) => (re.test(line) ? [`${file}:${i + 1}`] : [])),
  );
}

describe('surface reach into the store', () => {
  it('no src/mcp file imports the SQLite adapter', () => {
    expect(linesMatching(tsFilesUnder('mcp'), /['"](\.\.\/)+store\/sqlite\//)).toEqual([]);
  });

  it('the memory routes import nothing from src/store and decide no store capability', () => {
    expect(linesMatching(['server/routes/memories.ts'], /['"](\.\.\/)+store\/|\bhasGroup\b/)).toEqual([]);
  });
});
