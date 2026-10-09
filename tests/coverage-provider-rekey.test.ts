// The coverage gate reads one count per construct whichever source map located it: vitest workers and spawned
// CLI children report different columns for the same code, and the merge credits a key it cannot match with its enclosing block.
import { afterEach, describe, expect, it, vi } from 'vitest';
import v8 from '@vitest/coverage-v8';
import { createCoverageMap } from '@vitest/istanbul-lib-coverage';

// Loaded on demand: vitest hands this file to Node as TypeScript, which only a Node with type stripping can read.
const loadProvider = () => import('./_coverage-provider.js');
const NODE_READS_TYPESCRIPT = process.features.typescript !== undefined && process.features.typescript !== false;

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

describe.skipIf(!NODE_READS_TYPESCRIPT)('coverage re-keying across the worker and child source maps', () => {
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

  it('a file with no construct stays in the report', async () => {
    const { canonicalizeCoverage } = await loadProvider();
    const files = { [FILE]: report({}), '/repo/src/other.ts': report({ path: '/repo/src/other.ts', statementMap: { 0: loc(1, 0, 1, 4) }, s: { 0: 0 } }) };
    canonicalizeCoverage(files);
    expect(Object.keys(createCoverageMap(files).toJSON())).toEqual([FILE, '/repo/src/other.ts']);
  });
});

describe.skipIf(!NODE_READS_TYPESCRIPT)('the provider wrapped around vitest\'s v8 provider', () => {
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
