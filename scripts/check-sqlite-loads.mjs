#!/usr/bin/env node
// Fails when src names node:sqlite outside its two loaders, in any form a lint import rule misses (a renamed
// createRequire, process.getBuiltinModule, a worker source string), or imports a module by a computed specifier.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

const SQLITE = /^node:sqlite$/;
// The two files that load SQLite, and the one whose worker source string loads it in its own thread.
const LOADERS = new Set(['src/db/sqlite.ts', 'src/host/file-lock.ts']);
const WORKER_SOURCE = 'src/db/wal-checkpointer.ts';
// SHORTCUT: a computed import() is failed only in the data layer; elsewhere its target is known only at run time
// (src/infra/transformers.ts loads an optional package by URL), so a run-time import hook is the upgrade path.
const DATA_LAYER = /^src\/(db|store)\//;

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

const isText = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** Each `file:line` that names node:sqlite or imports by a computed specifier. */
function sitesIn(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const sites = [];
  const at = (node, what) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    sites.push(`${file}:${line} ${what}`);
  };
  const visit = (node) => {
    if (isText(node) && SQLITE.test(node.text) && !LOADERS.has(file)) at(node, 'names node:sqlite');
    const inSource =
      ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node);
    if (inSource && !SQLITE.test(node.getText(sf).slice(1, -1)) && /['"]node:sqlite['"]/.test(node.getText(sf))) {
      if (file !== WORKER_SOURCE) at(node, 'loads node:sqlite in a source string');
    }
    const dynamic = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const computed = dynamic && !(node.arguments.length > 0 && isText(node.arguments[0]));
    if (computed && DATA_LAYER.test(file)) at(node, 'imports a computed specifier');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

const sites = (existsSync('src') ? tsFiles('src') : []).flatMap(sitesIn);
if (sites.length > 0) {
  console.error(`SQLite loaded or a module imported where no gate sees it:\n  ${sites.join('\n  ')}`);
  console.error('Reach SQLite through src/db/sqlite.ts, and import a module by a string literal.');
  process.exit(1);
}
console.log('SQLite loads OK: only src/db/sqlite.ts and src/host/file-lock.ts load node:sqlite.');
