// Every git subprocess in src carries a timeout, so a wedged git (credential prompt, lock, huge repo) cannot hang a command.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve('src');
const GIT_CALL = /\b(?:execFileSync|execSync|spawnSync)\(\s*['"`]git\b/g;

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

describe('git subprocess timeouts', () => {
  it('every synchronous git call in src passes a timeout', () => {
    const missing: string[] = [];
    let calls = 0;
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(GIT_CALL)) {
        calls++;
        if (!/\btimeout\s*:/.test(callText(source, match.index ?? 0))) {
          const line = source.slice(0, match.index).split('\n').length;
          missing.push(`${path.relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});
