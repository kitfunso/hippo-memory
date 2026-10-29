#!/usr/bin/env node
// Prints the test files a change reaches, one per line (or --json), so a lane runs what its diff touches, not a guess.
// Usage: node scripts/affected-tests.mjs [--json] [--base <ref>] [changed file ...]; no file means changes since <ref>.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { listSources, SOURCE } from './lib/source-files.mjs';
import { EVAL_TESTS } from './lib/test-classes.mjs';
import { readFacts } from './lib/ts-facts.mjs';

const SCANNED = ['src', 'tests', 'scripts', 'benchmarks', 'evals', 'bin'];
const TEST = /^tests\/.*\.test\.(?:ts|mjs)$/;
const PACKAGE = /^hippo-memory(?:\/|$)/;
const LOADERS = /^(?:require|vi\.(?:mock|doMock|importActual|importMock))$/;
// Virtual nodes: a file that names a folder as text, or the package by name, reads whatever changes under it.
const TEXT = { dist: '#dist', docs: '#docs', src: '#src' };
const BY_NAME = '#package';
const TEXT_SEGMENT = /(?:^|[/\\])(dist|docs|src)(?:[/\\]|$)/;

/** The repo file at `target`: dist/<x>.js is src/<x>.ts, and a .js name is its .ts source. */
function fileAt(files, target) {
  if (target.startsWith('..')) return null;
  const built = /^dist\/(.+?)(?:\.d)?\.(?:js|mjs|cjs|ts)$/.exec(target);
  if (built) return `src/${built[1]}.ts`;
  const typed = target
    .replace(/\.js$/, '.ts')
    .replace(/\.mjs$/, '.mts')
    .replace(/\.cjs$/, '.cts');
  const found = [target, typed, `${target}.ts`, `${target}.js`, `${target}/index.ts`].find((f) => files.has(f));
  // A file that is gone keeps its key, so a deleted module still reaches its old importers.
  return found ?? typed;
}

// `join(root, 'bin', 'hippo.js')` names one path, so a call's literal arguments are read together too.
const literalPath = (args) =>
  args
    .filter((arg) => ts.isStringLiteralLike(arg))
    .map((arg) => arg.text)
    .join('/');

const isText = (node) =>
  ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);

/** What a source loads at run time (kept imports, `import()`, require, vi.mock, dist/ files) and its other strings. */
function readSource(text, file) {
  const { sourceFile, imports, distImports } = readFacts(text, file, ['imports', 'distImports']);
  const specs = imports.filter((i) => !i.typeOnly).map((i) => i.spec);
  const specNodes = new Set();
  const strings = [];
  const visit = (node) => {
    const isCall = ts.isCallExpression(node) && node.arguments.length > 0;
    const loads =
      isCall &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || LOADERS.test(node.expression.getText(sourceFile)));
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specNodes.add(node.moduleSpecifier);
    if (loads && ts.isStringLiteralLike(node.arguments[0])) {
      specNodes.add(node.arguments[0]);
      specs.push(node.arguments[0].text);
    }
    if (isCall && !loads) strings.push(literalPath(node.arguments));
    if (isText(node) && !specNodes.has(node)) strings.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { specs, strings, distImports };
}

/** The source file a string names from `dir` or the repo root, with a dist/ path read as its src source. */
function namedSource(files, dir, s) {
  if (!SOURCE.test(s)) return undefined;
  for (const target of [posix.join(dir, s), posix.normalize(s)]) {
    const at = target.startsWith('dist/') ? fileAt(files, target) : target;
    if (files.has(at)) return at;
  }
  return undefined;
}

/** The files and virtual nodes `file` reaches; only files outside src count as reading the tree as text. */
function edgesOf(root, files, file) {
  const text = readFileSync(join(root, file), 'utf8');
  const { specs, strings, distImports } = readSource(text, file);
  const dir = posix.dirname(file);
  const to = new Set();
  for (const spec of specs) {
    if (PACKAGE.test(spec)) to.add(BY_NAME);
    else if (spec.startsWith('.')) to.add(fileAt(files, posix.join(dir, spec)));
  }
  for (const imp of distImports) to.add(fileAt(files, imp.fromRepo ? imp.spec : posix.join(dir, imp.spec)));
  // A module a file starts by path (a worker, a child, `new URL(path, import.meta.url)`) is reached as an import is.
  for (const s of strings) {
    const named = namedSource(files, dir, s);
    if (named) to.add(named);
  }
  if (!file.startsWith('src/')) {
    for (const s of strings) {
      const folder = TEXT_SEGMENT.exec(s)?.[1];
      if (folder) to.add(TEXT[folder]);
      // bin/hippo.js loads dist/cli.js, so a file that runs it reads the build.
      if (s.includes('bin/hippo.js')) to.add(TEXT.dist);
    }
  }
  to.delete(null);
  return to;
}

/** Where a change starts: the changed files, the build for src and bin, the package and src text for src, docs. */
function startsOf(changed) {
  const starts = new Set(changed);
  for (const top of changed.map((file) => file.split('/')[0])) {
    if (top === 'src' || top === 'bin') starts.add(TEXT.dist);
    if (top === 'src') starts.add(TEXT.src).add(BY_NAME);
    if (top === 'docs') starts.add(TEXT.docs);
  }
  return starts;
}

/**
 * The tests a change reaches: through imports (dist and bin as their src), by package name while src changed, by
 * naming a dist, docs or src path as text while that folder changed, or by changing. Eval tests are left out.
 * @param {string} root repo root
 * @param {readonly string[]} changed repo-relative paths
 * @returns {{ tests: string[], excluded: string[] }}
 */
export function affectedTests(root, changed) {
  const files = new Set(SCANNED.flatMap((dir) => listSources(root, dir)));
  const importers = new Map();
  for (const file of files) {
    for (const target of edgesOf(root, files, file)) {
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  const seen = startsOf(changed.map((f) => posix.normalize(f.replace(/\\/g, '/'))));
  const queue = [...seen];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const from of importers.get(next) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      queue.push(from);
    }
  }
  const reached = [...seen].filter((f) => TEST.test(f) && files.has(f)).sort();
  return {
    tests: reached.filter((f) => !EVAL_TESTS.includes(f)),
    excluded: reached.filter((f) => EVAL_TESTS.includes(f)),
  };
}

/** Files changed since HEAD left `base`, uncommitted and new ones too; a rename keeps the old path for importers. */
export function changedSince(root, base) {
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 }).split('\n').filter(Boolean);
  const [from] = git('merge-base', base, 'HEAD');
  const edited = git('diff', '--name-only', '--no-renames', from);
  return [...new Set([...edited, ...git('ls-files', '--others', '--exclude-standard')])];
}

const USAGE = 'node scripts/affected-tests.mjs [--json] [--base <ref> | --base=<ref>] [changed file ...]';

/**
 * The command's flags and named files; a flag it does not know, or `--base` with no ref, throws.
 * @param {readonly string[]} args
 * @returns {{ json: boolean, base: string, files: string[] }}
 */
export function readArgs(args) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean', default: false }, base: { type: 'string', default: 'origin/next/3.0' } },
    allowPositionals: true,
  });
  if (values.base === '') throw new Error("Option '--base' needs a ref, as in --base=origin/next/3.0");
  return { json: values.json, base: values.base, files: positionals };
}

function fail(problem, fix) {
  console.error(`affected-tests: ${problem}`);
  console.error(`Fix: ${fix}`);
  process.exit(2);
}

// Guarded so the test can import affectedTests without running the command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args;
  try {
    args = readArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message, `run ${USAGE}`);
  }
  const root = resolve(import.meta.dirname, '..');
  let changed = args.files;
  if (changed.length === 0) {
    try {
      changed = changedSince(root, args.base);
    } catch (err) {
      fail(
        `git could not list the changes since ${args.base} (${err.message.split('\n')[0]}).`,
        'fetch the base (git fetch origin), pass --base <ref>, or name the changed files as arguments.',
      );
    }
  }
  const { tests, excluded } = affectedTests(root, changed);
  if (args.json) {
    console.log(JSON.stringify({ changed, tests, excluded }, null, 2));
  } else {
    for (const test of tests) console.log(test);
    if (excluded.length > 0) {
      console.error(
        `affected-tests: left out ${excluded.length} eval tests, which npm run test:eval runs: ${excluded.join(', ')}`,
      );
    }
  }
}
