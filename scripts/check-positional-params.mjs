#!/usr/bin/env node
// CI gate: no declaration in src/ takes 6 or more positional parameters (a rest parameter counts as none); take one
// options object. No baseline. Usage: check-positional-params.mjs [--list]; --list prints those with 4 or more.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export const LIMIT = 6;
// The port lane is closing the store adapters' long lists; delete this list once it merges.
export const SKIPPED = ['src/store/sqlite/', 'src/store/port/'];

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

const positional = (node) =>
  node.parameters.filter((p) => !p.dotDotDotToken && !(ts.isIdentifier(p.name) && p.name.text === 'this')).length;

/** The name a declaration answers to: its own, or the variable or property holding it. */
function labelOf(node) {
  if (node.name) return node.name.getText();
  const p = node.parent;
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText();
  return ts.isConstructorDeclaration(node) ? 'constructor' : '(anonymous)';
}

/** Every `src/file:line name` under `root` with at least `min` positional parameters, signatures and function types
 * included; the skipped folders are not read. */
export function findLongLists(root, min = LIMIT) {
  const found = [];
  const files = tsFiles(join(root, 'src')).map((f) => relative(root, f).replaceAll('\\', '/'));
  for (const file of files.filter((f) => !SKIPPED.some((dir) => f.startsWith(dir)))) {
    const text = readFileSync(join(root, file), 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (node.parameters && ts.isFunctionLike(node) && positional(node) >= min) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        found.push({ site: `${file}:${line} ${labelOf(node)}`, count: positional(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

function main(args) {
  if (!existsSync('src')) {
    console.error(`src/ not found in ${process.cwd()}.`);
    return 1;
  }
  if (args.includes('--list')) {
    for (const { site, count } of findLongLists('.', 4)) console.log(`${count}\t${site}`);
    return 0;
  }
  const long = findLongLists('.');
  if (long.length > 0) {
    console.error(`Declarations in src/ with ${LIMIT} or more positional parameters:`);
    for (const { site, count } of long) console.error(`  ${site}: ${count}`);
    console.error('Take one options object instead. `--list` shows every declaration with 4 or more.');
    return 1;
  }
  console.log(`Positional parameters OK: no declaration in src/ takes ${LIMIT} or more (store adapters not counted).`);
  return 0;
}

// Guarded so the test can import findLongLists without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
