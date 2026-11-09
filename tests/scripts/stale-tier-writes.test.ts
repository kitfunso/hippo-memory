// Only markStale writes the stale confidence tier, so no second writer can skip its once-per-cause half-life rule.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');
const MARK_STALE = 'src/base/memory/stale-mark.ts';
// A string is kept whole, so a comment marker inside one is not read as a comment.
const STRINGS_AND_COMMENTS = /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
// `confidence: 'stale'` and `.confidence = 'stale'`, in any of the three quote forms.
const STALE_TIER_WRITE = /\bconfidence\s*[:=]\s*(['"`])stale\1/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(dir, name));
}

/** The 1-based line of every stale-tier write in `text`, comments out; blanked comments keep the line numbers. */
function staleWriteLines(text: string): number[] {
  const code = text.replace(STRINGS_AND_COMMENTS, (hit) =>
    hit.startsWith('//') || hit.startsWith('/*') ? hit.replace(/[^\n]/g, ' ') : hit,
  );
  return [...code.matchAll(STALE_TIER_WRITE)].map((m) => code.slice(0, m.index).split('\n').length);
}

describe('stale tier writes', () => {
  it('only src/base/memory/stale-mark.ts writes the stale confidence tier', () => {
    const hits: string[] = [];
    const files = tsFiles(join(REPO, 'src'));
    for (const file of files) {
      const path = relative(REPO, file).split(sep).join('/');
      if (path === MARK_STALE) continue;
      for (const line of staleWriteLines(readFileSync(file, 'utf8'))) hits.push(`${path}:${line}`);
    }
    // Proves the scan reached src at all.
    expect(files.length).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });

  it('sees a field and an assignment in every quote form, and skips comments and other tiers', () => {
    const sample = [
      "const a = { confidence: 'stale' };",
      'b.confidence = "stale";',
      'const c = { confidence: `stale` };',
      "// confidence: 'stale'",
      "/* entry.confidence = 'stale' */",
      "const d = { confidence: 'observed' };",
      "if (e.confidence === 'stale') return;",
    ].join('\n');
    expect(staleWriteLines(sample)).toEqual([1, 2, 3]);
  });
});
