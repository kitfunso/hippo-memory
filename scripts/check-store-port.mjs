#!/usr/bin/env node
// CI store-port gate. Every server route should reach the database through the store port, so the leftovers
// (database openers outside the data layer, store branches in the API, routes not yet store-ready, twin
// functions) are counted and may fall but never rise above .store-port-baseline.json.
// Usage: check-store-port.mjs [--list] [--update]. --update lowers the baseline and refuses to raise any number.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

const BASELINE = '.store-port-baseline.json';
const OPENERS = new Set(['openHippoDb', 'openHippoDbReadOnly', 'openStore', 'onHandle']);
const TWIN_SUFFIX = /(ThroughStore|OnHippoDb|UnderStore|OnStore)$/;
const NUMBERS = ['openersOutside', 'openersInCli', 'storeBranches', 'routesWithoutStore', 'twinFunctions'];

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

const isCli = (f) => f.startsWith('src/cli/') || f === 'src/cli.ts';
const isDataLayer = (f) => f.startsWith('src/db/') || f.startsWith('src/store/') || f === 'src/db.ts';

/** Names that open a database in this file: the opener names plus every local alias bound to one. */
function openerNames(sf) {
  const names = new Set(OPENERS);
  const visit = (n) => {
    if ((ts.isImportSpecifier(n) || ts.isBindingElement(n)) && n.propertyName && ts.isIdentifier(n.propertyName)) {
      if (OPENERS.has(n.propertyName.text) && ts.isIdentifier(n.name)) names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Calls of an opener (or alias) plus re-exports of an opener name; imports, comments and strings never match. */
function countOpeners(sf) {
  const names = openerNames(sf);
  let n = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e) && names.has(e.text)) n++;
      else if (ts.isPropertyAccessExpression(e) && OPENERS.has(e.name.text)) n++;
    } else if (ts.isExportSpecifier(node) && OPENERS.has((node.propertyName ?? node.name).text)) n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

const endsInStore = (e) => ts.isPropertyAccessExpression(e) && e.name.text === 'store';
const isKindOfStore = (e) =>
  ts.isPropertyAccessExpression(e) && e.name.text === 'kind' &&
  ((ts.isIdentifier(e.expression) && e.expression.text === 'store') || endsInStore(e.expression));

/** Ternaries on `<x>.store` and `store.kind` comparisons against a string: the per-backend branches in src/api. */
function countStoreBranches(sf) {
  let n = 0;
  const visit = (node) => {
    if (ts.isConditionalExpression(node) && endsInStore(node.condition)) n++;
    else if (ts.isBinaryExpression(node) && /^[!=]==?$/.test(node.operatorToken.getText(sf))) {
      const other = isKindOfStore(node.left) ? node.right : isKindOfStore(node.right) ? node.left : undefined;
      if (other && ts.isStringLiteralLike(other)) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function countTwins(sf) {
  let n = 0;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && TWIN_SUFFIX.test(node.name.text)) n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

/** V1_ROUTES entries (one `{ method:` per line) without a storeReady field. */
function countRoutesWithoutStore(text) {
  const start = text.indexOf('const V1_ROUTES');
  if (start < 0) return 0;
  const end = text.indexOf('\n];', start);
  const block = text.slice(start, end < 0 ? undefined : end);
  return block.split('\n').filter((l) => /^\s*\{ method:/.test(l) && !l.includes('storeReady')).length;
}

/** All five numbers plus the per-file opener counts for src/, keys sorted. */
function measure() {
  const out = { openersOutside: 0, openersInCli: 0, storeBranches: 0, routesWithoutStore: 0, twinFunctions: 0 };
  const byFile = {};
  for (const file of existsSync('src') ? tsFiles('src') : []) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const openers = countOpeners(sf);
    if (isCli(file)) out.openersInCli += openers;
    else if (!isDataLayer(file)) {
      out.openersOutside += openers;
      if (openers > 0) byFile[file] = openers;
    }
    if (file.startsWith('src/api/')) out.storeBranches += countStoreBranches(sf);
    out.twinFunctions += countTwins(sf);
    if (file === 'src/server.ts') out.routesWithoutStore = countRoutesWithoutStore(text);
  }
  return { ...out, openersOutsideByFile: byFile };
}

/** Numbers and files that went above the baseline, as [label, was, now]. */
function rises(base, cur) {
  const rose = [];
  for (const k of NUMBERS) if (cur[k] > (base[k] ?? 0)) rose.push([k, base[k] ?? 0, cur[k]]);
  const was = base.openersOutsideByFile ?? {};
  for (const [f, n] of Object.entries(cur.openersOutsideByFile)) if (n > (was[f] ?? 0)) rose.push([f, was[f] ?? 'new', n]);
  return rose;
}

const current = measure();
const args = process.argv.slice(2);
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const total = NUMBERS.map((k) => `${k} ${current[k]}`).join(', ');

if (args.includes('--list')) {
  for (const k of NUMBERS) console.log(`${current[k]}\t${k}`);
  for (const [f, n] of Object.entries(current.openersOutsideByFile).sort(([, a], [, b]) => b - a)) console.log(`${n}\t${f}`);
  process.exit(0);
}

const rose = rises(baseline ?? {}, current);

if (args.includes('--update')) {
  if (baseline && rose.length > 0) {
    console.error('Refusing to raise the store-port baseline:');
    for (const [key, was, n] of rose) console.error(`  ${key}: ${was} -> ${n}`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total}.`);
  process.exit(0);
}

if (rose.length > 0) {
  console.error('Store-port counts rose above the baseline:');
  for (const [key, was, n] of rose) console.error(`  ${key}: ${was} -> ${n}`);
  console.error('Reach the database through the store port instead of opening it, branching on the store, or adding a twin.');
  console.error('`node scripts/check-store-port.mjs --list` shows every count.');
  process.exit(1);
}
const fell = baseline && (NUMBERS.some((k) => current[k] < (baseline[k] ?? 0)) ||
  Object.entries(baseline.openersOutsideByFile ?? {}).some(([f, n]) => (current.openersOutsideByFile[f] ?? 0) < n));
if (fell) console.log('Some counts fell below the baseline; run `node scripts/check-store-port.mjs --update` to lock that in.');
console.log(`Store-port ratchet OK: ${total}, none above ${BASELINE}.`);
