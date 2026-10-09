// Every synchronous subprocess in src carries a timeout, so a child that never answers (credential prompt, lock, stuck scheduler) cannot hang a command.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve('src');
const SYNC_CALL = /\b(?:execFileSync|execSync|spawnSync)\(/g;

/** Calls that may run unbounded, as `file: reason`. A call belongs here only when stopping it early would be the bug. */
const UNBOUNDED: ReadonlyMap<string, string> = new Map();

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return sourceFiles(full);
    return d.name.endsWith('.ts') ? [full] : [];
  });
}

/** The text of the call starting at `start`, up to its balanced closing parenthesis. */
function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/** `timeout: value` or the shorthand `timeout,` in the call's options. */
const PASSES_TIMEOUT = /\btimeout\s*[:,}]/;

describe('synchronous subprocess timeouts', () => {
  it('every execFileSync, execSync and spawnSync call in src passes a timeout', () => {
    const missing: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      const name = path.relative(SRC, file).replaceAll('\\', '/');
      for (const match of source.matchAll(SYNC_CALL)) {
        calls++;
        if (PASSES_TIMEOUT.test(callText(source, match.index)) || UNBOUNDED.has(name)) continue;
        missing.push(`${name}:${source.slice(0, match.index).split('\n').length}`);
      }
    }
    expect(calls).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it('allows no file that has since gained a timeout or lost its calls', () => {
    const stale = [...UNBOUNDED.keys()].filter((name) => {
      const file = path.join(SRC, name);
      if (!fs.existsSync(file)) return true;
      const source = fs.readFileSync(file, 'utf8');
      const calls = [...source.matchAll(SYNC_CALL)];
      // True for a file with no calls left, too.
      return calls.every((m) => PASSES_TIMEOUT.test(callText(source, m.index)));
    });
    expect(stale).toEqual([]);
  });
});
