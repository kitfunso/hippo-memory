// v8 coverage that also counts spawned `node dist/cli.js` children, mapped back to src/*.ts.
// Children map through tsc's source maps and workers through vite's, which disagree on columns;
// without one shared key per construct, a file loaded both ways would count everything twice.
import v8 from '@vitest/coverage-v8';
import type { CoverageProviderModule } from 'vitest/node';

interface Pos { line: number; column: number | null }
interface Loc { start: Pos; end: Pos }
interface Fn { name: string; loc: Loc; decl: Loc }
interface Branch { type: string; loc: Loc; locations: Loc[] }
interface FileData { statementMap: Record<string, Loc>; fnMap: Record<string, Fn>; branchMap: Record<string, Branch> }

// Both pipelines agree on a construct's first and last line, so it is keyed by those lines plus its
// rank among constructs sharing them; the rank stands in for the column, which they do not agree on.
function rekey<M>(map: Record<string, M>, locOf: (m: M) => Loc, place: (m: M, loc: Loc) => M): void {
  const groups = new Map<string, string[]>();
  for (const [id, m] of Object.entries(map)) {
    const { start, end } = locOf(m);
    const k = `${start.line}:${end.line}`;
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  const col = (id: string): number => locOf(map[id]).start.column ?? 0;
  for (const ids of groups.values()) {
    ids.sort((a, b) => col(a) - col(b)).forEach((id, rank) => {
      const { start, end } = locOf(map[id]);
      map[id] = place(map[id], { start: { line: start.line, column: rank }, end: { line: end.line, column: null } });
    });
  }
}

/** Rewrites each file's locations in place so the same source construct has one key whichever pipeline saw it. */
export function canonicalizeCoverage(files: Record<string, FileData>): void {
  for (const d of Object.values(files)) {
    rekey(d.statementMap, (l) => l, (_, loc) => loc);
    // A function's decl line agrees across pipelines; its body start can sit on a later line in one of them.
    rekey(d.fnMap, (fn) => ({ start: fn.decl.start, end: fn.loc.end }), (fn, loc) => ({ ...fn, loc, decl: loc }));
    rekey(d.branchMap, (br) => br.locations[0] ?? br.loc,
      (br, loc) => ({ ...br, loc, locations: br.locations.map((l, i) => (i === 0 ? loc : { start: l.start, end: { line: l.end.line, column: null } })) }));
  }
}

const isDist = (file: string): boolean => /[\\/]dist[\\/]/.test(file);

interface V8Internals {
  remapCoverage(...args: unknown[]): Promise<Record<string, FileData>>;
  getUntestedFiles(tested: string[]): Promise<string[]>;
}
const hasInternals = <T extends object>(p: T): p is T & V8Internals =>
  'remapCoverage' in p && typeof p.remapCoverage === 'function' && 'getUntestedFiles' in p && typeof p.getUntestedFiles === 'function';

// vitest.config.ts imports this natively (server.deps.external): --merge-reports stubs any vite-loaded module a blob lists.
const mod: CoverageProviderModule = {
  ...v8,
  async getProvider() {
    const p = await v8.getProvider();
    if (!hasInternals(p)) throw new Error('@vitest/coverage-v8 no longer has remapCoverage/getUntestedFiles; update tests/_coverage-provider.ts');
    const remap = p.remapCoverage.bind(p);
    const untested = p.getUntestedFiles.bind(p);
    // dist/ is in coverage.include only so child results pass the pre-remap filter; src/ already lists every untested file.
    p.getUntestedFiles = async (tested) => (await untested(tested)).filter((f) => !isDist(f));
    // Before any merge: istanbul credits an unmatched key with the hits of its enclosing block.
    p.remapCoverage = async (...args) => {
      const files = await remap(...args);
      canonicalizeCoverage(files);
      return files;
    };
    return p;
  },
};

export default mod;
