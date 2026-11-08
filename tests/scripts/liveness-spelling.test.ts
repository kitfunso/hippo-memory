// No src file but sql-predicates.ts and the frozen migrations spells a `superseded_by` predicate, and no
// file but liveness.ts reads a memory's link outside the pinned value uses: both fail with file:line.
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');

const SQL_SPELLINGS: readonly RegExp[] = [
  /superseded_by\s+(?:IS|ISNULL|NOTNULL|NOT\s+NULL)\b/g,
  /superseded_by\s*(?:<>|!=|=)\s*''/g,
  /(?:COALESCE|IFNULL|NULLIF)\([^)]*superseded_by/g,
];

function exempt(path: string): boolean {
  return path === 'db/sql-predicates.ts' || path.startsWith('db/migrations/');
}

function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

interface SrcFile {
  readonly path: string;
  readonly text: string;
}

/** Every .ts file under src with comment lines blanked, so line numbers stay true and a statement the
 * formatter breaks over lines still matches. */
function srcFiles(): SrcFile[] {
  const files: SrcFile[] = [];
  for (const name of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    const path = name.split(sep).join('/');
    if (!path.endsWith('.ts')) continue;
    const text = readFileSync(join(SRC, name), 'utf8')
      .split('\n')
      .map((line) => (isComment(line) ? '' : line))
      .join('\n');
    files.push({ path, text });
  }
  return files;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** `path:line` of every SQL spelling. */
function spellings(): string[] {
  const found: string[] = [];
  for (const { path, text } of srcFiles()) {
    if (exempt(path)) continue;
    for (const form of SQL_SPELLINGS) {
      for (const hit of text.matchAll(form)) {
        found.push(`src/${path}:${lineOf(text, hit.index)}: ${hit[0].replace(/\s+/g, ' ')}`);
      }
    }
  }
  return found.sort();
}

describe('liveness SQL spelling', () => {
  it('lives in src/db/sql-predicates.ts alone, outside the migrations', () => {
    expect(spellings()).toEqual([]);
  });
});

const LINK = String.raw`\b(?:supersededBy|superseded_by)\b`;
// A member read of either name (a joined alias such as `r.a_superseded_by` too), a destructure that
// binds the name, and a declaration whose pattern renames it; a type member or object key is no read.
const LINK_READS: readonly RegExp[] = [
  /\.supersededBy\b/g,
  /\.\w*superseded_by\b/g,
  new RegExp(String.raw`\{[^{}]*${LINK}(?!\s*\??:)[^{}]*\}\s*(?::|=(?!=|>)|\)\s*=>)`, 'g'),
  new RegExp(String.raw`(?:const|let|var)\s*\{[^{}]*${LINK}[^{}]*\}\s*=(?!=|>)`, 'g'),
];

/** `src/path:line: text` of every read of a link, by file; a read both a member form and a
 * destructure form match counts once. */
function linkReads(): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const { path, text } of srcFiles()) {
    if (path === 'base/memory/liveness.ts') continue;
    const at = new Map<number, string>();
    for (const form of LINK_READS) {
      for (const hit of text.matchAll(form)) {
        const index = hit.index + hit[0].search(/supersededBy|superseded_by/);
        at.set(index, `src/${path}:${lineOf(text, index)}: ${hit[0].replace(/\s+/g, ' ')}`);
      }
    }
    if (at.size > 0) {
      byFile.set(
        path,
        [...at.entries()].sort(([a], [b]) => a - b).map(([, hit]) => hit),
      );
    }
  }
  return byFile;
}

const TRIGGER = 'frozen trigger text on a record table, never a memory';
const RECORD = 'a record row (decision, policy, entity), not a memory';

/** Exact counts, so a value use that turns into a truthy test fails; a boolean reading of a memory
 * never goes in here, it is `isSuperseded`. */
const KEPT_READS = {
  'api/memories/promote.ts': { reads: 1, why: 'the already-superseded message names the successor id' },
  'api/recall/rows.ts': { reads: 2, why: 'the wire row copies the link: assignment target and value' },
  'base/memory/half-life-plan.ts': { reads: 1, why: 'collects successor ids so a move skips their copies' },
  'base/memory/markdown.ts': { reads: 1, why: 'frontmatter mapper from the wire field' },
  'base/memory/memory-wire.ts': { reads: 2, why: 'wire mapper both ways' },
  'db/migrations/v30.ts': { reads: 5, why: TRIGGER },
  'db/migrations/v32.ts': { reads: 5, why: TRIGGER },
  'db/migrations/v33.ts': { reads: 5, why: TRIGGER },
  'db/migrations/v34.ts': { reads: 5, why: TRIGGER },
  'db/migrations/v35.ts': { reads: 5, why: TRIGGER },
  'db/migrations/v36.ts': { reads: 5, why: TRIGGER },
  'domain/graph/extract.ts': { reads: 4, why: `entity rows: ${RECORD}` },
  'domain/graph/recall.ts': { reads: 2, why: 'successor id lookups, after the isSuperseded check' },
  'domain/search/as-of.ts': { reads: 1, why: 'successor lookup, after the isSuperseded check' },
  'store/sqlite/entries/entry-row.ts': { reads: 1, why: 'the row writer passes the stored link through' },
  'store/sqlite/recall/candidates.ts': { reads: 1, why: 'search row to entry mapper' },
  'store/sqlite/records/object-rows.ts': { reads: 2, why: `object rows: ${RECORD}` },
  'store/sqlite/records/objects.ts': { reads: 2, why: `join text on a policy row: ${RECORD}` },
  'store/sqlite/reports/reports.ts': { reads: 1, why: 'join text: a blank link never matches a successor id' },
  'store/sqlite/review/conflicts.ts': { reads: 3, why: 'joined columns to conflict member mapper' },
  'store/sqlite/runtime/rows.ts': { reads: 2, why: 'row mapper and the create default' },
  'surface/cli/decisions.ts': { reads: 2, why: `printed link of ${RECORD}` },
  'surface/cli/object-verbs.ts': { reads: 2, why: `printed link of ${RECORD}` },
  'surface/cli/remember.ts': { reads: 1, why: 'the conflict message names the successor id' },
} satisfies Record<string, { readonly reads: number; readonly why: string }>;

describe('liveness TS reads', () => {
  it('sit in the pinned files with their exact counts and nowhere else', () => {
    const found = linkReads();
    const keptByFile = new Map<string, { readonly reads: number }>(Object.entries(KEPT_READS));
    const problems: string[] = [];
    for (const [path, hits] of found) {
      const kept = keptByFile.get(path);
      if (kept === undefined) {
        problems.push(`unlisted: ${hits.join(' | ')}`);
      } else if (kept.reads !== hits.length) {
        problems.push(`${kept.reads} listed, ${hits.length} found: ${hits.join(' | ')}`);
      }
    }
    for (const path of keptByFile.keys()) {
      if (!found.has(path)) problems.push(`src/${path} is listed with no read left`);
    }
    expect(problems).toEqual([]);
  });
});
