// E10 lane A: the default-deny SQL lives in scopeAdmitSql alone, so a new read site cannot hand-roll a clause that drops the owner arm.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const HAND_ROLLED = /:private:%|%:private:|(LIKE|GLOB)\s+['"`][^'"`]*(:private|personal:)|instr\([^)]*:private|['"`]unknown:legacy['"`]/i;
const SCOPE_MODULE = join('store', 'recall-scope.ts');
const ALLOWED = new Set([SCOPE_MODULE]);
// Migrations stamp the legacy marker once, as data, and never read through it.
const EXEMPT_DIR = `db${sep}migrations${sep}`;
// Doc lines that name the rule; exempt by file and exact text, so an edited or added line is read again.
const DOC_LINES = new Set([
  'api/assemble.ts: * `unknown:legacy` rows.',
  "sharing/search-both.ts: *    `{}`                                  = default-deny (`unknown:legacy`",
  "store/handoffs.ts: // continuity excludes slack:private:* and 'unknown:legacy'.",
  "store/sessions.ts: // continuity reads applies to slack:private:* and 'unknown:legacy' rows.",
  "store/search-rows.ts: /** Recall-mode loader: scope predicate in SQL so `unknown:legacy` cannot leak. Empty `requestedScope` default-denies (admits `ownScope`); else exact match.",
  "store/search-rows.ts: * SQL `NOT LIKE '%:private:%'` runs before the LIMIT so private rows cannot starve admitted ones; `passesScopeFilterForRecall` is the exact post-filter. */",
]);

function hitsIn(file: string, text: string): string[] {
  const name = file.split(sep).join('/');
  return text.split(/\r?\n/).flatMap((line, i) =>
    HAND_ROLLED.test(line) && !DOC_LINES.has(`${name}: ${line.trim()}`) ? [`${name}:${i + 1}: ${line.trim()}`] : []);
}

const hits = (file: string): string[] => hitsIn(file, readFileSync(join(SRC, file), 'utf8'));
const sources = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));

describe('scope SQL guard', () => {
  it('finds the patterns where they belong, so the scan is live', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(hits(SCOPE_MODULE).length).toBeGreaterThan(0);
  });

  it('no other source file spells the default-deny SQL or the legacy marker', () => {
    const offenders = sources
      .filter((f) => !ALLOWED.has(f) && !f.startsWith(EXEMPT_DIR))
      .flatMap(hits);
    expect(offenders).toEqual([]);
  });

  it('flags every hand-rolled shape, a comment-shaped line included, and passes only the listed doc lines', () => {
    const bad = [
      "AND scope NOT LIKE '%:private:%'", "AND scope NOT GLOB '*:private:*'", "AND instr(scope, ':private:') = 0",
      "AND scope NOT LIKE 'personal:%'", "AND scope <> 'unknown:legacy'", "* AND scope NOT GLOB '*:private:*'",
      "// AND scope NOT LIKE '%:private:%'",
    ];
    for (const line of bad) expect(hitsIn('store/x.ts', line), line).toHaveLength(1);
    expect(hitsIn(`store${sep}handoffs.ts`, "  // continuity excludes slack:private:* and 'unknown:legacy'.")).toEqual([]);
    expect(hitsIn(`store${sep}handoffs.ts`, "  // continuity excludes 'unknown:legacy' too.")).toHaveLength(1);
  });

  it('every listed doc line still exists, so the list cannot hold a stale pass', () => {
    const live = new Set(sources.flatMap((f) => readFileSync(join(SRC, f), 'utf8').split(/\r?\n/).map((l) => `${f.split(sep).join('/')}: ${l.trim()}`)));
    expect([...DOC_LINES].filter((l) => !live.has(l))).toEqual([]);
  });
});
