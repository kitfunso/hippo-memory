// A light subpath loads in a hook process on a machine with no store, so its runtime imports must not reach one.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { runtimeSpecifiers } from '../scripts/check-import-cycles.mjs';

const SRC = resolve(__dirname, '..', 'src');
const HEAVY = /(?:^|\/)(?:store|db|server|api)(?:\/|\.ts$)|(?:^|\/)index\.ts$/;

function resolveTs(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Every src module `entry` loads at runtime, as paths relative to src/. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      const next = resolveTs(file, spec);
      expect(next, `${file} imports ${spec}`).not.toBeNull();
      queue.push(next!);
    }
  }
  return [...seen].map((f) => relative(SRC, f).replace(/\\/g, '/')).sort();
}

describe('light subpath import closures', () => {
  it('hippo-memory/session-text reaches no store, db, server, api or index module', () => {
    const closure = importClosure('entry/session-text.ts');
    // The walk follows re-exports, so every module the entry names is in it.
    expect(closure).toEqual(expect.arrayContaining([
      'capture/transcript.ts', 'share-scrub.ts', 'home-path.ts', 'secret-detect.ts',
      'capture/working-state.ts', 'capture/failure-reading.ts', 'handoff-evidence.ts', 'compaction-items.ts',
    ]));
    expect(closure.filter((f) => HEAVY.test(f))).toEqual([]);
  });
});
