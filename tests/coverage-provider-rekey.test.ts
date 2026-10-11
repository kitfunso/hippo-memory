// The coverage gate reads one count per construct whichever source map located it: vitest workers and spawned
// CLI children report different columns for the same code, and the merge credits a key it cannot match with its enclosing block.
import { afterEach, describe, expect, it, vi } from 'vitest';
import v8 from '@vitest/coverage-v8';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';

const loadProvider = () => import('./_coverage-provider.mjs');

const FILE = '/repo/src/sample.ts';
const loc = (line: number, from: number, endLine: number, to: number) => ({ start: { line, column: from }, end: { line: endLine, column: to } });

interface Report {
  path: string;
  statementMap: Record<string, ReturnType<typeof loc>>;
  fnMap: Record<string, { name: string; line: number; decl: ReturnType<typeof loc>; loc: ReturnType<typeof loc> }>;
  branchMap: Record<string, { type: string; line: number; loc: ReturnType<typeof loc>; locations: ReturnType<typeof loc>[] }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

const report = (parts: Partial<Report>): Report => ({ path: FILE, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {}, ...parts });

/** What the gate reads after both pipelines' reports of one file are re-keyed and merged, as the provider does before vitest merges. */
async function merged(worker: Report, child: Report) {
  const { canonicalizeCoverage } = await loadProvider();
  canonicalizeCoverage({ [FILE]: worker });
  canonicalizeCoverage({ [FILE]: child });
  const map = createCoverageMap({ [FILE]: worker });
  map.merge({ [FILE]: child });
  return map.fileCoverageFor(FILE);
}

describe('coverage re-keying across the worker and child source maps', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('two statements on one line keep their own counts', async () => {
    const file = await merged(
      report({ statementMap: { 0: loc(3, 2, 3, 6), 1: loc(3, 8, 3, 12) }, s: { 0: 1, 1: 0 } }),
      report({ statementMap: { 0: loc(3, 4, 3, 9), 1: loc(3, 11, 3, 16) }, s: { 0: 0, 1: 5 } }),
    );
    expect(Object.values(file.s)).toEqual([1, 5]);
  });

  it('a statement neither pipeline ran is not credited with the hits of the block around it', async () => {
    const file = await merged(
      report({ statementMap: { 0: loc(1, 0, 5, 1), 1: loc(3, 4, 3, 20) }, s: { 0: 7, 1: 0 } }),
      report({ statementMap: { 0: loc(1, 0, 5, 3), 1: loc(3, 6, 3, 24) }, s: { 0: 7, 1: 0 } }),
    );
    expect(Object.values(file.s)).toEqual([14, 0]);
  });

  it('a function whose body starts a line later in one pipeline is still one function', async () => {
    const fn = (bodyLine: number, column: number) => ({ name: 'run', line: 2, decl: loc(2, column, 2, column + 3), loc: loc(bodyLine, column, 6, 1) });
    const file = await merged(
      report({ fnMap: { 0: fn(2, 9) }, f: { 0: 2 } }),
      report({ fnMap: { 0: fn(3, 2) }, f: { 0: 3 } }),
    );
    expect(Object.values(file.f)).toEqual([5]);
  });

  it('two branches on one line keep their own arm counts', async () => {
    const branch = (column: number) => ({ type: 'cond-expr', line: 4, loc: loc(4, column, 4, column + 9), locations: [loc(4, column, 4, column + 3), loc(4, column + 5, 4, column + 9)] });
    const file = await merged(
      report({ branchMap: { 0: branch(2), 1: branch(20) }, b: { 0: [1, 0], 1: [0, 0] } }),
      report({ branchMap: { 0: branch(6), 1: branch(27) }, b: { 0: [0, 2], 1: [0, 4] } }),
    );
    expect(Object.values(file.b)).toEqual([[1, 2], [0, 4]]);
  });

  /** The provider re-keys a report in place, so a case reads the report back after one pass. */
  async function keyed(parts: Partial<Report>): Promise<Report> {
    const { canonicalizeCoverage } = await loadProvider();
    const r = report(parts);
    canonicalizeCoverage({ [FILE]: r });
    return r;
  }

  it('a statement with no start column ranks first on its line', async () => {
    // Parsed because istanbul types a column as a number, while v8 locations can lack one and the provider's own types allow it.
    const noColumn: ReturnType<typeof loc> = JSON.parse('{"start":{"line":3,"column":null},"end":{"line":3,"column":6}}');
    const r = await keyed({ statementMap: { 0: loc(3, 8, 3, 12), 1: noColumn } });
    expect([r.statementMap[0].start.column, r.statementMap[1].start.column]).toEqual([1, 0]);
  });

  it('a function takes one key for its declaration and its body and keeps its name', async () => {
    const r = await keyed({ fnMap: { 0: { name: 'run', line: 2, decl: loc(2, 9, 2, 12), loc: loc(3, 9, 6, 1) } } });
    const key = { start: { line: 2, column: 0 }, end: { line: 6, column: null } };
    expect(r.fnMap[0]).toMatchObject({ name: 'run', decl: key, loc: key });
  });

  it('a branch is keyed by its first arm, and later arms keep their start line and column', async () => {
    const r = await keyed({ branchMap: { 0: { type: 'if', line: 4, loc: loc(4, 2, 4, 20), locations: [loc(4, 5, 4, 9), loc(4, 12, 6, 1)] } } });
    expect(r.branchMap[0].loc).toEqual({ start: { line: 4, column: 0 }, end: { line: 4, column: null } });
    expect(r.branchMap[0].locations).toEqual([
      { start: { line: 4, column: 0 }, end: { line: 4, column: null } },
      { start: { line: 4, column: 12 }, end: { line: 6, column: null } },
    ]);
  });

  it('a branch with no arms is keyed by its own span and stays without arms', async () => {
    const r = await keyed({ branchMap: {
      0: { type: 'if', line: 1, loc: loc(1, 4, 3, 1), locations: [] },
      1: { type: 'if', line: 1, loc: loc(1, 0, 3, 1), locations: [] },
    } });
    expect([r.branchMap[0].loc.start.column, r.branchMap[1].loc.start.column]).toEqual([1, 0]);
    expect(r.branchMap[0].locations).toEqual([]);
  });

  it('a report that is already keyed comes through a second pass unchanged', async () => {
    const r = await keyed({
      statementMap: { 0: loc(3, 8, 3, 12), 1: loc(3, 2, 3, 6) },
      fnMap: { 0: { name: 'run', line: 2, decl: loc(2, 9, 2, 12), loc: loc(3, 9, 6, 1) }, 1: { name: 'go', line: 2, decl: loc(2, 3, 2, 5), loc: loc(2, 3, 6, 1) } },
      branchMap: { 0: { type: 'if', line: 4, loc: loc(4, 2, 4, 20), locations: [loc(4, 5, 4, 9), loc(4, 12, 6, 1)] }, 1: { type: 'if', line: 4, loc: loc(4, 30, 4, 40), locations: [loc(4, 31, 4, 35)] } },
    });
    const once = structuredClone(r);
    const { canonicalizeCoverage } = await loadProvider();
    canonicalizeCoverage({ [FILE]: r });
    expect(r).toEqual(once);
  });

  it('a file with no construct stays in the report', async () => {
    const { canonicalizeCoverage } = await loadProvider();
    const files = { [FILE]: report({}), '/repo/src/other.ts': report({ path: '/repo/src/other.ts', statementMap: { 0: loc(1, 0, 1, 4) }, s: { 0: 0 } }) };
    canonicalizeCoverage(files);
    expect(Object.keys(createCoverageMap(files).toJSON())).toEqual([FILE, '/repo/src/other.ts']);
  });
});

describe('the provider wrapped around vitest\'s v8 provider', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  interface Wrapped { getUntestedFiles(tested: string[]): Promise<string[]>; remapCoverage(): Promise<Record<string, Report>> }
  /** Stands in for vitest's provider: the two private methods the wrapper replaces, answering with literals. */
  function stubbed(internals: Partial<Wrapped>): void {
    // SAFETY: the wrapper reads only the two methods a case supplies; the rest of the provider is never touched here.
    vi.spyOn(v8, 'getProvider').mockResolvedValue(internals as Awaited<ReturnType<typeof v8.getProvider>>);
  }

  /** Vitest's public provider type leaves out the two private methods the wrapper replaces. */
  function assertWrapped<T extends object>(provider: T): asserts provider is T & Wrapped {
    expect(provider).toHaveProperty('getUntestedFiles');
    expect(provider).toHaveProperty('remapCoverage');
  }

  it('reports a source file no test loaded as untested, and leaves out only built files', async () => {
    const untested = ['/repo/src/never-loaded.ts', '/repo/dist/cli.js', 'C:\\repo\\dist\\server\\boot.js', '/repo/src/distance.ts'];
    stubbed({ remapCoverage: async () => ({}), getUntestedFiles: async () => untested });
    const { default: mod } = await loadProvider();
    const provider = await mod.getProvider();
    assertWrapped(provider);
    const listed = await provider.getUntestedFiles([]);
    expect(listed).toEqual(['/repo/src/never-loaded.ts', '/repo/src/distance.ts']);
  });

  it('keeps a file outside src/ unless it is built output', async () => {
    const untested = ['/repo/scripts/build.mjs', '/repo/tests/helper.ts', '/repo/mydist/cli.js', '/repo/packages/web/dist/index.js', 'C:/repo/dist\\cli.js'];
    stubbed({ remapCoverage: async () => ({}), getUntestedFiles: async () => untested });
    const { default: mod } = await loadProvider();
    const provider = await mod.getProvider();
    assertWrapped(provider);
    expect(await provider.getUntestedFiles([])).toEqual(['/repo/scripts/build.mjs', '/repo/tests/helper.ts', '/repo/mydist/cli.js']);
  });

  it('re-keys what the v8 provider remapped before handing it on', async () => {
    const files = { [FILE]: report({ statementMap: { 0: loc(3, 2, 3, 6), 1: loc(3, 8, 3, 12) }, s: { 0: 1, 1: 0 } }) };
    stubbed({ remapCoverage: async () => files, getUntestedFiles: async () => [] });
    const { default: mod } = await loadProvider();
    const provider = await mod.getProvider();
    assertWrapped(provider);
    const out = await provider.remapCoverage();
    expect(Object.values(out[FILE].statementMap).map((l) => [l.start.column, l.end.column])).toEqual([[0, null], [1, null]]);
  });

  it('refuses to start when the v8 provider no longer has the two methods it wraps', async () => {
    stubbed({ getUntestedFiles: async () => [] });
    const { default: mod } = await loadProvider();
    await expect(mod.getProvider()).rejects.toThrow(/no longer has remapCoverage\/getUntestedFiles/);
  });

  it('starts on the installed v8 provider', async () => {
    const { default: mod } = await loadProvider();
    await expect(mod.getProvider()).resolves.toBeDefined();
  });
});
