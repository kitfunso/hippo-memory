// The SessionEnd worker is detached, so on Windows it has no console: a child
// started without windowsHide gets its own visible terminal window.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CALL = /\b(execFileSync|execSync|spawnSync|spawn|execFile)\(/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** Text of the call from its opening paren to the matching close paren. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function findCalls(): { site: string; text: string }[] {
  return tsFiles('src')
    .filter((f) => /from ['"](node:)?child_process['"]/.test(readFileSync(f, 'utf8')))
    .flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(CALL)].map((m) => ({
        site: `${f}:${src.slice(0, m.index).split('\n').length}`,
        text: callText(src, m.index! + m[0].length - 1),
      }));
    });
}

describe('child_process window hiding', () => {
  it('finds the known call sites, so the scan itself is alive', () => {
    expect(findCalls().length).toBeGreaterThanOrEqual(20);
  });

  it('every call sets windowsHide explicitly', () => {
    const missing = findCalls().filter((c) => !c.text.includes('windowsHide')).map((c) => c.site);
    expect(missing).toEqual([]);
  });
});
