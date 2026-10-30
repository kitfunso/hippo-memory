#!/usr/bin/env node
// Fails when a script, benchmark, eval or test imports a dist/ file the build no longer makes, or a value that file no
// longer exports: module moves broke such imports twice, and only the one shard that ran them noticed. Run after build.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { listSources } from '../lib/source-files.mjs';
import { readFacts } from '../lib/ts-facts.mjs';

export const SCANNED = ['scripts', 'benchmarks', 'evals', 'tests'];

/** `<file> -> <specifier>` keys of imports left broken on purpose, each with why. Keep it empty: fix the import. */
export const ALLOWED = {};

const TS_SOURCE = /\.(?:ts|mts|cts)$/;

/** Exports of each declaration file that carry no value, so a TypeScript import of one without `type` is no miss. */
function typeOnlyExports(dtsFiles) {
  // Symbol flags need no lib types, and parsing the default libs cost seconds per call.
  const program = ts.createProgram(dtsFiles, { noEmit: true, noLib: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  return new Map(
    dtsFiles.map((file) => {
      const source = program.getSourceFile(file);
      const module = source && checker.getSymbolAtLocation(source);
      const exports = module ? checker.getExportsOfModule(module) : [];
      const valueless = exports.filter((e) => {
        const target = e.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(e) : e;
        return !(target.flags & ts.SymbolFlags.Value);
      });
      return [file, new Set(valueless.map((e) => e.name))];
    }),
  );
}

/** Loads each dist/ target once; a missing file or a load error is the target's whole result. */
async function loadTargets(targets) {
  const loaded = new Map();
  for (const target of targets) {
    if (!existsSync(target)) {
      loaded.set(target, { error: 'is not built' });
      continue;
    }
    try {
      loaded.set(target, { mod: await import(pathToFileURL(target).href) });
    } catch (err) {
      loaded.set(target, { error: `does not load (${err.code ?? err.message})` });
    }
  }
  return loaded;
}

/** Each import's target inside the repo's dist/, or none for a fixture's own dist folder. */
function withTargets(repo, files) {
  const dist = resolve(repo, 'dist') + sep;
  return files.flatMap((rel) => {
    const file = join(repo, rel);
    const text = readFileSync(file, 'utf8');
    if (!text.includes('dist')) return [];
    return readFacts(text, file, ['distImports']).distImports.flatMap((imp) => {
      const target = resolve(imp.fromRepo ? repo : dirname(file), imp.spec);
      return target.startsWith(dist) ? [{ file: rel, isTs: TS_SOURCE.test(file), target, ...imp }] : [];
    });
  });
}

/**
 * Every dist/ import under `roots` of `repo` that does not load, or lacks a value it names, less the allowed ones.
 * @param {string} repo
 * @param {{ roots?: readonly string[], allowed?: Record<string, string> }} [opts]
 * @returns {Promise<{ checked: number, problems: { file: string, line: number, spec: string, problem: string }[] }>}
 */
export async function checkDistImports(repo, { roots = SCANNED, allowed = ALLOWED } = {}) {
  const imports = withTargets(
    repo,
    roots.flatMap((root) => listSources(repo, root)),
  );
  const loaded = await loadTargets(new Set(imports.map((imp) => imp.target)));
  const missing = imports.map((imp) => {
    const mod = loaded.get(imp.target).mod ?? {};
    return { imp, gone: imp.names.filter((n) => !(n in mod)) };
  });
  const dts = (target) => target.slice(0, -extname(target).length) + '.d.ts';
  const typed = missing.filter(({ imp, gone }) => imp.isTs && gone.length > 0 && existsSync(dts(imp.target)));
  const types = typed.length > 0 ? typeOnlyExports([...new Set(typed.map(({ imp }) => dts(imp.target)))]) : new Map();
  const problems = missing.flatMap(({ imp, gone }) => {
    const { error } = loaded.get(imp.target);
    const values = gone.filter((n) => !types.get(dts(imp.target))?.has(n));
    const problem = error ?? (values.length > 0 ? `lacks ${values.join(', ')}` : null);
    if (!problem || Object.hasOwn(allowed, `${imp.file} -> ${imp.spec}`)) return [];
    return [{ file: imp.file, line: imp.line, spec: imp.spec, problem }];
  });
  problems.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  return { checked: imports.length, problems };
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = resolve(process.argv[2] ?? '.');
  if (!existsSync(join(repo, 'dist', 'index.js'))) {
    console.error('dist/index.js is missing: run `npm run build` first.');
    process.exit(1);
  }
  const { checked, problems } = await checkDistImports(repo);
  if (problems.length > 0) {
    console.error(`\ndist/ imports in ${SCANNED.join(', ')} that the build no longer serves:`);
    for (const p of problems) console.error(`  ${p.file}:${p.line} -> ${p.spec}: ${p.problem}`);
    console.error('\nFix: point the import at the file that exports the name now, often dist/index.js.\n');
    process.exit(1);
  }
  console.log(`${checked} dist/ imports in ${SCANNED.join(', ')} load, with every value they name. OK.`);
}
