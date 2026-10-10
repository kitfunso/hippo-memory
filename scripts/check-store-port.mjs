#!/usr/bin/env node
// CI store-port gate. Every server route should reach the database through the store port, so the leftovers
// (database openers outside the data layer, store branches in the API, routes not yet store-ready (a sqliteOnly route is counted apart, and its list is pinned), twin
// functions, SQL prepared outside the data layer, hand-written BEGIN literals) are counted and may fall but never rise above .store-port-baseline.json.
// routesOnLoop counts the routes whose SQLite work still runs on the server thread: V1_ROUTES rows without `loop: 'off'`, plus the routes outside that table.
// carrierFiles counts src files other than src/api/on-store.ts that name andThen or onStore, the sync-or-async reply carrier; the list is pinned so a new file fails even when another stops.
// A file under src/server/routes or src/cli that feeds a recall ring, counts recall stats or books a recall token row fails outright.
// Usage: check-store-port.mjs [--list] [--update]. --update lowers the baseline and refuses to raise any number.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

const BASELINE = '.store-port-baseline.json';
const OPENERS = new Set(['openHippoDb', 'openHippoDbReadOnly', 'openStore', 'onHandle']);
const TWIN_SUFFIX = /(ThroughStore|OnHippoDb|UnderStore|OnStore)$/;
const NUMBERS = ['openersOutside', 'openersInCli', 'storeBranches', 'routesWithoutStore', 'sqliteOnlyRoutes', 'routesOnLoop', 'twinFunctions', 'sqlOutside', 'txLiterals', 'tenantResolvesInCli'];
// Routes dispatched outside V1_ROUTES. Named here so the count cannot read 0 while they answer on the server thread; a name leaves when its route does.
const OFF_TABLE_ROUTES = ['POST /mcp', 'GET /mcp/stream', 'POST /v1/connectors/slack/events', 'POST /v1/connectors/github/events', 'GET /health', 'GET /ready', 'POST add-on routes'];
const TX_OWNER = 'src/db/busy.ts';
const CARRIER_OWNER = 'src/api/on-store.ts';
// What src/api/recall-finish.ts does for a surface that passes `recordAs`. No baseline: one hit fails. src/mcp is pending and not read.
const RECALL_RECORDERS = new Set(['bumpRecallStats', 'noteRecall']);
const RECALL_LEDGER_LABELS = new Set(['recall', 'http_recall', 'mcp_recall']);
const recordsItsOwnRecall = (f) => f.startsWith('src/server/routes/') || f.startsWith('src/cli/');

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

const isCli = (f) => f.startsWith('src/cli/') || f === 'src/cli.ts';
const isDataLayer = (f) => f.startsWith('src/db/') || f.startsWith('src/store/') || f === 'src/db/index.ts';

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

/** Calls of `resolveTenantId(`: the CLI resolves its tenant once, at dispatch, and hands it down. */
function countTenantResolves(sf) {
  let n = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'resolveTenantId') n++;
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

const routeFail = (why) => {
  console.error(`check-store-port: src/server/route-table.ts V1_ROUTES ${why}; the route count would read low. Declare it as an object literal with a string-literal storeReady or sqliteOnly, or update readRoutes.`);
  process.exit(1);
};

const propNamed = (row, name) => row.properties.find((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
const rowLabel = (row, sf) => {
  const m = propNamed(row, 'method');
  const where = ['path', 'pattern', 'regex'].map((k) => propNamed(row, k)).find(Boolean);
  const text = (p) => (p && ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : '?');
  return `${text(m).replace(/'/g, '')} ${text(where).replace(/'/g, '')}`;
};

const isOffLoop = (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'loop' && ts.isStringLiteralLike(p.initializer) && p.initializer.text === 'off';

/** Reads the V1_ROUTES array literal: rows with neither a string-literal storeReady nor a non-empty string-literal sqliteOnly, the sorted `METHOD path` of the sqliteOnly rows,
 *  and the rows that do not declare `loop: 'off'` plus every route outside the table. */
function readRoutes(sf) {
  let array;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'V1_ROUTES' && n.initializer) {
      let init = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isArrayLiteralExpression(init)) array = init;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!array) return routeFail('is not declared as an array literal');
  let without = 0;
  let onLoop = OFF_TABLE_ROUTES.length;
  const sqliteOnly = [];
  for (const row of array.elements) {
    const at = `row at line ${sf.getLineAndCharacterOfPosition(row.getStart(sf)).line + 1}`;
    if (!ts.isObjectLiteralExpression(row)) return routeFail(`has a spread or non-object element (${at})`);
    if (!row.properties.some(isOffLoop)) onLoop++;
    const label = rowLabel(row, sf);
    const store = propNamed(row, 'storeReady');
    const only = propNamed(row, 'sqliteOnly');
    if (store && only) return routeFail(`row ${label} declares both storeReady and sqliteOnly`);
    if (store && !(ts.isPropertyAssignment(store) && ts.isStringLiteralLike(store.initializer))) return routeFail(`row ${label} has a storeReady that is not a string literal`);
    if (only) {
      if (!(ts.isPropertyAssignment(only) && ts.isStringLiteralLike(only.initializer) && only.initializer.text.trim() !== '')) return routeFail(`row ${label} has a sqliteOnly that is not a non-empty string literal`);
      sqliteOnly.push(label);
    } else if (!store) without++;
  }
  return { without, sqliteOnly: sqliteOnly.sort(), onLoop };
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

const namesRecallLabel = (node) => (ts.isStringLiteralLike(node) && RECALL_LEDGER_LABELS.has(node.text)) || ts.forEachChild(node, namesRecallLabel) === true;

/** `file:line name` for each mention of a recall recorder, and each recordTokens call that names a recall label; comments and strings never match. */
function recallRecordsIn(file, sf) {
  const hits = [];
  const at = (node, what) => hits.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${what}`);
  const visit = (node) => {
    if (ts.isIdentifier(node) && RECALL_RECORDERS.has(node.text)) at(node, node.text);
    else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'recordTokens' && node.arguments.some(namesRecallLabel)) at(node, 'recordTokens with a recall label');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Every surface file outside src/mcp that records a recall itself. */
function strayRecallRecords() {
  return (existsSync('src') ? tsFiles('src') : [])
    .filter(recordsItsOwnRecall)
    .flatMap((file) => recallRecordsIn(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)));
}

/** Method names of `interface SqliteLocal`: each is a write only hippo.db can run, so the list grows only by a hand edit of the baseline. */
function localMethods(sf) {
  const local = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'SqliteLocal');
  return local ? local.members.map((m) => m.name.getText(sf)).sort() : [];
}

/** All numbers plus the per-file opener and prepare counts for src/, keys sorted, and the SqliteLocal method names. */
function measure() {
  const out = { openersOutside: 0, openersInCli: 0, storeBranches: 0, routesWithoutStore: 0, sqliteOnlyRoutes: 0, routesOnLoop: 0, twinFunctions: 0, sqlOutside: 0, txLiterals: 0, tenantResolvesInCli: 0 };
  const byFile = {};
  const sqlByFile = {};
  let sqliteLocalMethods = [];
  let sqliteOnlyRoutesList = [];
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
    if (file.startsWith('src/cli/')) out.tenantResolvesInCli += countTenantResolves(sf);
    if (file.startsWith('src/api/')) out.storeBranches += countStoreBranches(sf);
    out.twinFunctions += countTwins(sf);
    if (file !== CARRIER_OWNER && usesCarrier(sf)) carrierFilesList.push(file);
    if (file === 'src/server/route-table.ts') {
      const routes = readRoutes(sf);
      out.routesWithoutStore = routes.without;
      out.sqliteOnlyRoutes = routes.sqliteOnly.length;
      sqliteOnlyRoutesList = routes.sqliteOnly;
      out.routesOnLoop = routes.onLoop;
    }
    if (file === 'src/store/sqlite/local.ts') sqliteLocalMethods = localMethods(sf);
  }
  return { ...out, openersOutsideByFile: byFile, sqlOutsideByFile: sqlByFile, sqliteLocalMethods, sqliteOnlyRoutesList, carrierFiles: carrierFilesList.length, carrierFilesList };
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
  const onlyListed = base?.sqliteOnlyRoutesList ?? [];
  for (const r of cur.sqliteOnlyRoutesList) if (!onlyListed.includes(r)) rose.push([`sqliteOnly ${r}`, 'unlisted', 'declared']);
  return rose;
}

const strays = strayRecallRecords();
if (strays.length > 0) {
  console.error('A surface records a recall itself:');
  for (const hit of strays) console.error(`  ${hit}`);
  console.error('Pass `recordAs` to retrieve() instead: src/api/recall-finish.ts feeds the ring, counts the stats and books the token row.');
  process.exit(1);
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
  (baseline.sqliteOnlyRoutesList ?? []).length > current.sqliteOnlyRoutesList.length ||
  current.carrierFiles < (baseline.carrierFiles ?? 0));
if (fell) console.log('Some counts fell below the baseline; run `node scripts/check-store-port.mjs --update` to lock that in.');
console.log(`Store-port ratchet OK: ${total}, none above ${BASELINE}.`);
