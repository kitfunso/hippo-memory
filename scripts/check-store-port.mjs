#!/usr/bin/env node
// CI store-port gate. Every server route should reach the database through the store port, so the leftovers
// (database openers outside the data layer, store branches in the API, routes not yet store-ready, twin
// functions, SQL prepared outside the data layer, hand-written BEGIN literals) are counted and may fall but never rise above .store-port-baseline.json.
// carrierFiles counts src files other than src/api/on-store.ts that name andThen or onStore, the sync-or-async reply carrier; the list is pinned so a new file fails even when another stops.
// Usage: check-store-port.mjs [--list] [--update]. --update lowers the baseline and refuses to raise any number.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

const BASELINE = '.store-port-baseline.json';
const OPENERS = new Set(['openHippoDb', 'openHippoDbReadOnly', 'openStore', 'onHandle']);
const TWIN_SUFFIX = /(ThroughStore|OnHippoDb|UnderStore|OnStore)$/;
const NUMBERS = ['openersOutside', 'openersInCli', 'storeBranches', 'routesWithoutStore', 'twinFunctions', 'sqlOutside', 'txLiterals'];
const TX_OWNER = 'src/db/busy.ts';
const CARRIER_OWNER = 'src/api/on-store.ts';

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

/** `<x>.store`, or a local named `store`, which is how the carrier in src/api/on-store.ts holds it. */
const endsInStore = (e) => (ts.isPropertyAccessExpression(e) ? e.name : e).text === 'store';
const isKindOfStore = (e) => ts.isPropertyAccessExpression(e) && e.name.text === 'kind' && endsInStore(e.expression);

/** Ternaries on `<x>.store` or a local `store`, and `store.kind` comparisons against a string: the per-backend branches in src/api. */
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

/** Calls of `<x>.prepare(...)`: SQL written by code that is not the data layer. */
function countPrepares(sf) {
  let n = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'prepare') n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

/** String, no-substitution template and template-head literals that start a transaction by hand. */
function countTxLiterals(sf) {
  let n = 0;
  const visit = (node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node);
    if (literal && node.text.trim().startsWith('BEGIN')) n++;
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
  if (start < 0) {
    console.error('check-store-port: `const V1_ROUTES` not found in src/server/route-table.ts; the route count would read 0. Update countRoutesWithoutStore to the new route table.');
    process.exit(1);
  }
  const end = text.indexOf('\n];', start);
  const block = text.slice(start, end < 0 ? undefined : end);
  return block.split('\n').filter((l) => /^\s*\{ method:/.test(l) && !l.includes('storeReady')).length;
}

/** True when the file names the reply carrier (`andThen` or `onStore`) as an identifier; comments and strings never match. */
function usesCarrier(sf) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && (node.text === 'andThen' || node.text === 'onStore')) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Method names of `interface SqliteLocal`: each is a write only hippo.db can run, so the list grows only by a hand edit of the baseline. */
function localMethods(sf) {
  const local = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'SqliteLocal');
  return local ? local.members.map((m) => m.name.getText(sf)).sort() : [];
}

/** All numbers plus the per-file opener and prepare counts for src/, keys sorted, and the SqliteLocal method names. */
function measure() {
  const out = { openersOutside: 0, openersInCli: 0, storeBranches: 0, routesWithoutStore: 0, twinFunctions: 0, sqlOutside: 0, txLiterals: 0 };
  const byFile = {};
  const sqlByFile = {};
  let sqliteLocalMethods = [];
  const carrierFilesList = [];
  for (const file of existsSync('src') ? tsFiles('src') : []) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const openers = countOpeners(sf);
    if (isCli(file)) out.openersInCli += openers;
    else if (!isDataLayer(file)) {
      out.openersOutside += openers;
      if (openers > 0) byFile[file] = openers;
    }
    if (!isDataLayer(file)) {
      const prepares = countPrepares(sf);
      out.sqlOutside += prepares;
      if (prepares > 0) sqlByFile[file] = prepares;
    }
    if (file !== TX_OWNER) out.txLiterals += countTxLiterals(sf);
    if (file.startsWith('src/api/')) out.storeBranches += countStoreBranches(sf);
    out.twinFunctions += countTwins(sf);
    if (file !== CARRIER_OWNER && usesCarrier(sf)) carrierFilesList.push(file);
    if (file === 'src/server/route-table.ts') out.routesWithoutStore = countRoutesWithoutStore(text);
    if (file === 'src/store/sqlite/local.ts') sqliteLocalMethods = localMethods(sf);
  }
  return { ...out, openersOutsideByFile: byFile, sqlOutsideByFile: sqlByFile, sqliteLocalMethods, carrierFiles: carrierFilesList.length, carrierFilesList };
}

/** Numbers, files and SqliteLocal methods that went above the baseline, as [label, was, now]. */
function rises(base, cur) {
  const rose = [];
  // A key the baseline has never held is a first write, not a rise; once written it ratchets like the rest.
  const firstWrite = (k) => base !== null && base[k] === undefined;
  for (const k of NUMBERS) if (!firstWrite(k) && cur[k] > (base?.[k] ?? 0)) rose.push([k, base?.[k] ?? 0, cur[k]]);
  for (const key of ['openersOutsideByFile', 'sqlOutsideByFile']) {
    if (firstWrite(key)) continue;
    const was = base?.[key] ?? {};
    for (const [f, n] of Object.entries(cur[key])) if (n > (was[f] ?? 0)) rose.push([f, was[f] ?? 'new', n]);
  }
  if (!firstWrite('carrierFiles') && cur.carrierFiles > (base?.carrierFiles ?? 0)) rose.push(['carrierFiles', base?.carrierFiles ?? 0, cur.carrierFiles]);
  if (!firstWrite('carrierFilesList')) {
    for (const f of cur.carrierFilesList) if (!(base?.carrierFilesList ?? []).includes(f)) rose.push([f, 'not a carrier file', 'uses andThen or onStore']);
  }
  const listed = base?.sqliteLocalMethods ?? [];
  for (const m of cur.sqliteLocalMethods) if (!listed.includes(m)) rose.push([`SqliteLocal.${m}`, 'unlisted', 'declared']);
  return rose;
}

const current = measure();
const args = process.argv.slice(2);
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const total = NUMBERS.map((k) => `${k} ${current[k]}`).join(', ');

if (args.includes('--list')) {
  for (const k of NUMBERS) console.log(`${current[k]}\t${k}`);
  console.log(`${current.carrierFiles}\tcarrierFiles`);
  for (const key of ['openersOutsideByFile', 'sqlOutsideByFile']) {
    for (const [f, n] of Object.entries(current[key]).sort(([, a], [, b]) => b - a)) console.log(`${n}\t${f}`);
  }
  process.exit(0);
}

const rose = rises(baseline, current);

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
  ['openersOutsideByFile', 'sqlOutsideByFile'].some((key) => Object.entries(baseline[key] ?? {}).some(([f, n]) => (current[key][f] ?? 0) < n)) ||
  (baseline.sqliteLocalMethods ?? []).length > current.sqliteLocalMethods.length ||
  current.carrierFiles < (baseline.carrierFiles ?? 0));
if (fell) console.log('Some counts fell below the baseline; run `node scripts/check-store-port.mjs --update` to lock that in.');
console.log(`Store-port ratchet OK: ${total}, none above ${BASELINE}.`);
