#!/usr/bin/env node
// CI store-port gate. Every server route should reach the database through the store port, so the leftovers (database openers outside the data layer, store branches in the API, routes that need hippo.db (storeReady 'localFiles' or hippoDbOnly; hippoDbOnly rows are counted apart too, and their list is pinned), twin
// functions, SQL prepared outside the data layer, hand-written BEGIN literals) are counted and may fall but never rise above .store-port-baseline.json.
// carrierFiles counts src files that name andThen, onStore or StoreReply, the removed sync-or-async reply carrier; the list is pinned so a new file fails even when another stops.
// storeImportsInDomain counts value imports, re-exports and import() calls from every folder layers.json marks domain into src/store or src/db: domain code reaches hippo.db through the port.
// storeFilesWithoutSql counts src/store files that run no SQL on hippo.db and are not on DB_DEFINITION_FILES; the list is pinned, so a pure helper filed under src/store fails.
// portImportsFromSql counts imports and re-exports in src/store/port.ts, src/store/port-groups.ts and src/store/port/ of a src/store file outside those, or of a src/db file that runs SQL (.prepare, .exec or node:sqlite): the port defines its own types.
// buildsOutsideRoots counts calls of sqliteStore, sqliteStoreOn or initStore (as imported from src/store or src/db) in src files outside the data layer and COMPOSITION_ROOTS.
// storeImportsInCli counts value imports of src/store or src/db in src/surface/cli files other than the CLI's composition root.
// groupChecksInApi counts requireGroup and hasGroup calls in files that layers.json puts in the api or a domain layer.
// portFunctionParams fails outright on any parameter of a method on a port interface whose type holds a function, through aliases, unions, object properties and imports: no function crosses to a store worker, so a rule goes to the store as data. No baseline.
// A file under src/surface/server/routes or src/surface/cli that feeds a recall ring, counts recall stats or books a recall token row fails outright.
// folderFormsAboveAdapter lists exported src/store functions outside src/store/sqlite that open hippo.db from a folder; any one fails outright.
// A .ts file directly in src/store other than STORE_TOP_FILES fails outright: a group's SQL goes in src/store/sqlite, a pure rule in src/base.
// A src/store function or port method whose tenant, or an argument's tenant property, is optional, defaulted or admits undefined or null fails outright.
// Usage: check-store-port.mjs [--list] [--update]. --update lowers the baseline and refuses to raise any number.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import ts from 'typescript';
import { lineOf, parse, portFunctionParams, resolveSpec } from './lib/port-type-facts.mjs';
import { looseTenants } from './lib/loose-tenants.mjs';

const BASELINE = '.store-port-baseline.json';
const OPENERS = new Set(['openHippoDb', 'openHippoDbReadOnly', 'openStore', 'onHandle']);
const TWIN_SUFFIX = /(ThroughStore|OnHippoDb|UnderStore|OnStore)$/;
const NUMBERS = [
  'openersOutside',
  'openersInCli',
  'storeBranches',
  'routesNeedingHippoDb',
  'hippoDbOnlyRoutes',
  'twinFunctions',
  'sqlOutside',
  'txLiterals',
  'tenantResolvesInCli',
  'storeImportsInCli',
  'storeImportsInDomain',
  'handleHoldersOutside',
  'storeFilesWithoutSql',
  'portImportsFromSql',
  'buildsOutsideRoots',
  'groupChecksInApi',
];
const BY_FILE_KEYS = ['openersOutsideByFile', 'sqlOutsideByFile', 'handleHoldersOutsideByFile'];
const HANDLE_TYPES = new Set(['DatabaseSyncLike', 'DatabaseSync']);
// src/store files that run no SQL yet belong there: hippo.db's shapes, SQL text and plumbing. A path ending in / covers its folder.
const DB_DEFINITION_FILES = {
  'src/store/port.ts': 'the store port every backend implements',
  'src/store/port/': 'store port groups kept apart from port.ts',
  'src/store/port-groups.ts': 'the session and admin groups of the store port',
  'src/store/index.ts': 'the published entry of the store port',
  'src/store/sqlite/': 'the SQLite adapter and its executor plumbing',
  'src/store/local/': 'the types of the stores a hippo.db root keeps beside its own',
  'src/store/memory/': 'the in-memory adapter, which keeps its rows in plain tables',
  'src/store/rules/': 'the row rules both adapters read: orders, column defaults and classifications',
};
const DB_TOUCH_NAMES = new Set([...OPENERS, ...HANDLE_TYPES, 'withWriteScope', 'withWriteScopeOr']);
const TX_OWNER = 'src/db/busy.ts';
const CARRIER_NAMES = new Set(['andThen', 'onStore', 'StoreReply']);
// What src/api/recall/finish.ts does for a surface that passes `recordAs`. No baseline: one hit fails. src/surface/mcp is pending and not read.
const RECALL_RECORDERS = new Set(['bumpRecallStats', 'noteRecall']);
const RECALL_LEDGER_LABELS = new Set(['recall', 'http_recall', 'mcp_recall']);
const recordsItsOwnRecall = (f) => f.startsWith('src/surface/server/routes/') || f.startsWith('src/surface/cli/');

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

const isCli = (f) => f.startsWith('src/surface/cli/') || f === 'src/cli.ts';
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

/** `<x>.store`, or a local named `store`, which is how an api function holds the port. */
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

/** 1 when this file's code names the database handle type: holding a raw handle is the same coupling as opening one, whatever the opener is called. */
function holdsHandle(sf) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && HANDLE_TYPES.has(node.text)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found ? 1 : 0;
}

/** Calls of `<x>.prepare(...)`: SQL written by code that is not the data layer. */
function countPrepares(sf) {
  let n = 0;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'prepare'
    ) {
      n++;
    }
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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'resolveTenantId') {
      n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

const reachesDataLayer = (file, spec) => spec.startsWith('.') && isDataLayer(posix.join(posix.dirname(file), spec));
const namesOnlyTypes = (clause) =>
  clause.isTypeOnly ||
  (!clause.name &&
    clause.namedBindings &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.every((e) => e.isTypeOnly));

/** Import lines that bring a value in from src/store or src/db: what the CLI still reads past the api. */
function countStoreImports(file, sf) {
  return sf.statements.filter(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      reachesDataLayer(file, s.moduleSpecifier.text) &&
      !(s.importClause && namesOnlyTypes(s.importClause)),
  ).length;
}

const DOMAIN = Object.entries(JSON.parse(readFileSync('layers.json', 'utf8')).folders)
  .filter(([, layer]) => layer === 'domain')
  .map(([folder]) => `src/${folder}/`);
const isDomain = (f) => DOMAIN.some((d) => f.startsWith(d));
const isValueImport = (s) => ts.isImportDeclaration(s) && !(s.importClause && namesOnlyTypes(s.importClause));
const isValueReexport = (s) =>
  ts.isExportDeclaration(s) &&
  !s.isTypeOnly &&
  !(s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.every((e) => e.isTypeOnly));

/** Value imports, value re-exports and `import()` calls of src/store or src/db: what domain code reads past the port. */
function countDomainStoreImports(file, sf) {
  const reaches = (spec) => spec && ts.isStringLiteral(spec) && reachesDataLayer(file, spec.text);
  let n = sf.statements.filter((s) => (isValueImport(s) || isValueReexport(s)) && reaches(s.moduleSpecifier)).length;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      reaches(node.arguments[0])
    ) {
      n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

const STORE_BUILDERS = new Set(['sqliteStore', 'sqliteStoreOn', 'initStore']);
const GROUP_CHECKS = new Set(['requireGroup', 'hasGroup']);
// Where a store may be built, each with why: every other file takes its store as a parameter or from the Context.
const COMPOSITION_ROOTS = new Map([
  ['src/surface/cli/api-context.ts', 'the CLI and the stdio MCP host build their store here'],
  ['src/surface/server/boot.ts', 'the HTTP server builds its store holder here'],
  ['src/surface/mcp/stdio.ts', 'the stdio MCP server, the one entry with no store found yet'],
  ['src/surface/server/sleep-child.ts', 'the sleep child is a process entry of its own, handed only a folder'],
  ['src/surface/server/dashboard-reader-thread.ts', 'a thread entry of its own, handed only a folder'],
  ['src/index.ts', 'the package root: consolidate(hippoRoot) builds the store of the folder it names'],
  [
    'src/entry/folder-search.ts',
    'the published hybridSearch and physicsSearch build the store of the folder they name',
  ],
  ['src/entry/importers.ts', 'the published importers build the store of the folder their options name'],
]);
const LAYERS = JSON.parse(readFileSync('layers.json', 'utf8'));
const layerOf = (f) => {
  const rel = f.slice('src/'.length);
  return rel.includes('/') ? LAYERS.folders[rel.split('/')[0]] : LAYERS.rootFiles?.[rel];
};
const sqlCache = new Map();
/** True when the file calls `<x>.prepare(` or `<x>.exec(` or imports node:sqlite; comments and strings never match. */
function runsSql(file) {
  if (!sqlCache.has(file)) {
    const sf = parse(file);
    let found = sf.statements.some(
      (s) =>
        ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === 'node:sqlite',
    );
    const visit = (node) => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(prepare|exec)$/.test(node.expression.name.text)
      ) {
        found = true;
      } else ts.forEachChild(node, visit);
    };
    visit(sf);
    sqlCache.set(file, found);
  }
  return sqlCache.get(file);
}

const isPortFile = (f) =>
  f === 'src/store/port.ts' || f === 'src/store/port-groups.ts' || f.startsWith('src/store/port/');

/** `file:line` of each import or re-export in a port file whose target is a src/store file outside the port, or a src/db file that runs SQL. */
function portSqlImports(file, sf) {
  if (!isPortFile(file)) return [];
  return sf.statements
    .filter(
      (s) =>
        (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
        s.moduleSpecifier &&
        ts.isStringLiteral(s.moduleSpecifier),
    )
    .filter((s) => {
      const target = resolveSpec(file, s.moduleSpecifier.text);
      return (
        target && isDataLayer(target) && !isPortFile(target) && (target.startsWith('src/store/') || runsSql(target))
      );
    })
    .map((s) => `${file}:${lineOf(sf, s)}`);
}

/** Local names bound to a src/store or src/db export of a builder name, so a same-named local function never counts. */
function builderNames(file, sf) {
  const names = new Set();
  for (const s of sf.statements) {
    if (
      !ts.isImportDeclaration(s) ||
      !ts.isStringLiteral(s.moduleSpecifier) ||
      !reachesDataLayer(file, s.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = s.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const e of bindings.elements) {
        if (STORE_BUILDERS.has((e.propertyName ?? e.name).text)) names.add(e.name.text);
      }
    }
  }
  return names;
}

/** `file:line` of each call of a name in `names`, as an identifier callee. */
function callsOf(file, sf, names) {
  const hits = [];
  if (names.size === 0) return hits;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
      hits.push(`${file}:${lineOf(sf, node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const buildsOutsideRootsHere = (file) => !isDataLayer(file) && !COMPOSITION_ROOTS.has(file);
const checksGroupsHere = (file) => ['api', 'domain'].includes(layerOf(file));

function countTwins(sf) {
  let n = 0;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && TWIN_SUFFIX.test(node.name.text)) n++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

const routeFail = (why, file = 'src/surface/server/route-table.ts') => {
  console.error(
    `check-store-port: ${file} ${why}; the route count would read low. Declare each route as an object literal whose storeReady and hippoDbOnly, if any, are string literals, or update readRoutes.`,
  );
  process.exit(1);
};

/** The initializer of the variable `name` in `sf`, unwrapped from as, satisfies and parentheses; undefined when none. */
function declaredValue(sf, name) {
  let found;
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name && n.initializer) {
      let init = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) {
        init = init.expression;
      }
      found = init;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const propNamed = (row, name) =>
  row.properties.find((p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
const rowLabel = (row, sf) => {
  const m = propNamed(row, 'method');
  const where = ['path', 'pattern', 'regex'].map((k) => propNamed(row, k)).find(Boolean);
  const text = (p) => (p && ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : '?');
  return `${text(m).replace(/'/g, '')} ${text(where).replace(/'/g, '')}`;
};
const KIND_ROWS = 'src/surface/server/routes/kind-routes.ts';
const builtRows = (row) => /^\.\.\.(kindRows|objectRoutes|versionedRoutes)\(/.test(row.getText());

/** Reads the V1_ROUTES array literal: rows that need hippo.db (storeReady 'localFiles' or a non-empty string-literal hippoDbOnly) and the sorted `METHOD path` of the hippoDbOnly rows. A spread of one kind's built rows needs none, as kind-routes.ts builds them all and names no status. */
function readRoutes(sf) {
  const array = declaredValue(sf, 'V1_ROUTES');
  if (!array || !ts.isArrayLiteralExpression(array)) return routeFail('V1_ROUTES is not declared as an array literal');
  if (array.elements.some(builtRows) && /storeReady|hippoDbOnly/.test(readFileSync(KIND_ROWS, 'utf8'))) {
    return routeFail('builds rows that name a storeReady or hippoDbOnly', KIND_ROWS);
  }
  let needsHippoDb = 0;
  const hippoDbOnly = [];
  for (const row of array.elements.filter((r) => !builtRows(r))) {
    const at = `row at line ${sf.getLineAndCharacterOfPosition(row.getStart(sf)).line + 1}`;
    if (!ts.isObjectLiteralExpression(row)) return routeFail(`V1_ROUTES has a spread or non-object element (${at})`);
    const label = rowLabel(row, sf);
    const store = propNamed(row, 'storeReady');
    const only = propNamed(row, 'hippoDbOnly');
    if (store && only) return routeFail(`V1_ROUTES row ${label} declares both storeReady and hippoDbOnly`);
    if (store && !(ts.isPropertyAssignment(store) && ts.isStringLiteralLike(store.initializer))) {
      return routeFail(`V1_ROUTES row ${label} has a storeReady that is not a string literal`);
    }
    if (only) {
      const reason = ts.isPropertyAssignment(only) && only.initializer;
      if (!reason || !ts.isStringLiteralLike(reason) || reason.text.trim() === '') {
        return routeFail(`V1_ROUTES row ${label} has a hippoDbOnly that is not a non-empty string literal`);
      }
      hippoDbOnly.push(label);
      needsHippoDb++;
    } else if (store && store.initializer.text === 'localFiles') needsHippoDb++;
  }
  return { needsHippoDb, hippoDbOnly: hippoDbOnly.sort() };
}

/** True when the file names the reply carrier (`andThen`, `onStore` or `StoreReply`) as an identifier; comments and strings never match. */
function usesCarrier(sf) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && CARRIER_NAMES.has(node.text)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const namesRecallLabel = (node) =>
  (ts.isStringLiteralLike(node) && RECALL_LEDGER_LABELS.has(node.text)) ||
  ts.forEachChild(node, namesRecallLabel) === true;

/** `file:line name` for each mention of a recall recorder, and each recordTokens call that names a recall label; comments and strings never match. */
function recallRecordsIn(file, sf) {
  const hits = [];
  const at = (node, what) =>
    hits.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${what}`);
  const visit = (node) => {
    if (ts.isIdentifier(node) && RECALL_RECORDERS.has(node.text)) at(node, node.text);
    else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'recordTokens' && node.arguments.some(namesRecallLabel)) {
        at(node, 'recordTokens with a recall label');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Every surface file outside src/surface/mcp that records a recall itself. */
function strayRecallRecords() {
  return (existsSync('src') ? tsFiles('src') : [])
    .filter(recordsItsOwnRecall)
    .flatMap((file) =>
      recallRecordsIn(
        file,
        ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      ),
    );
}

// A call of one of these, under its name or an import alias, opens hippo.db from the folder it is given.
const FOLDER_OPENERS = new Set([
  ...OPENERS,
  'openHippoDbWithFacts',
  'withUnmigratedDb',
  'reproveStoreSchema',
  'onHandleAsync',
  'initStore',
  'handlesOf',
  'sqliteStore',
  'sqliteStoreOn',
]);
/** The file's top-level functions, declared or bound to a const, each with its node and whether the file exports it. */
function topLevelFunctions(sf) {
  const fns = new Map();
  const exported = (s) => s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name && s.body) fns.set(s.name.text, { node: s, exported: exported(s) });
    for (const d of ts.isVariableStatement(s) ? s.declarationList.declarations : []) {
      const init = d.initializer;
      if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        fns.set(d.name.text, { node: d, exported: exported(s) });
      }
    }
  }
  const localExports = sf.statements.filter(
    (s) => ts.isExportDeclaration(s) && !s.moduleSpecifier && s.exportClause && ts.isNamedExports(s.exportClause),
  );
  for (const s of localExports) {
    for (const e of s.exportClause.elements) {
      const fn = fns.get((e.propertyName ?? e.name).text);
      if (fn) fn.exported = true;
    }
  }
  return fns;
}

/** True when a parameter is a folder: named `...root`, destructuring one, or typed StoreFiles or Handles, which hold one. */
function takesFolder(sf, node) {
  const fn = ts.isVariableDeclaration(node) ? node.initializer : node;
  const isRoot = (name) => /root$/i.test(name);
  return fn.parameters.some(
    (p) =>
      (ts.isIdentifier(p.name) && isRoot(p.name.text)) ||
      (ts.isObjectBindingPattern(p.name) &&
        p.name.elements.some((e) => isRoot((e.propertyName ?? e.name).getText(sf)))) ||
      (p.type !== undefined && /\b(StoreFiles|Handles)\b/.test(p.type.getText(sf))),
  );
}

/** `file:line name` of each exported function taking a folder that names a folder opener (a call, a default, a
 * callback), in a closure or through a same-file helper too. */
function folderFormsIn(file, sf) {
  const openers = new Set(FOLDER_OPENERS);
  for (const s of sf.statements) {
    const bindings = ts.isImportDeclaration(s) ? s.importClause?.namedBindings : undefined;
    for (const e of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
      if (e.propertyName && FOLDER_OPENERS.has(e.propertyName.text)) openers.add(e.name.text);
    }
  }
  const fns = topLevelFunctions(sf);
  const named = new Map();
  for (const [name, { node }] of fns) {
    const names = new Set();
    // `ReturnType<typeof openHippoDb>` names a handle's type and opens nothing, so type positions are skipped.
    const visit = (n) => {
      if (ts.isTypeNode(n)) return;
      if (ts.isIdentifier(n)) names.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(ts.isVariableDeclaration(node) ? node.initializer : node);
    named.set(name, names);
  }
  const opens = new Set([...named].filter(([, names]) => [...names].some((c) => openers.has(c))).map(([n]) => n));
  // A helper that opens makes every same-file caller open too, however deep the chain.
  for (let grew = true; grew;) {
    const before = opens.size;
    for (const [name, names] of named) if ([...names].some((c) => c !== name && opens.has(c))) opens.add(name);
    grew = opens.size > before;
  }
  return [...opens]
    .filter((name) => fns.get(name).exported && takesFolder(sf, fns.get(name).node))
    .map((name) => `${file}:${lineOf(sf, fns.get(name).node)} ${name}`);
}

// The port and its published entry.
const STORE_TOP_FILES = new Set(['port.ts', 'port-groups.ts', 'index.ts']);

/** Each .ts file directly in src/store that STORE_TOP_FILES does not name. */
function strayStoreTopFiles() {
  if (!existsSync('src/store')) return [];
  return readdirSync('src/store', { withFileTypes: true })
    .filter((e) => e.isFile() && /\.[cm]?ts$/.test(e.name) && !STORE_TOP_FILES.has(e.name))
    .map((e) => `src/store/${e.name}`)
    .sort();
}

/** Every folder form in src/store outside the SQLite adapter, named exceptions included. */
function folderFormsAboveAdapter() {
  return (existsSync('src/store') ? tsFiles('src/store') : [])
    .filter((file) => !file.startsWith('src/store/sqlite/'))
    .flatMap((file) => folderFormsIn(file, parse(file)));
}

/** True when the file runs SQL itself (`<x>.prepare` or `<x>.exec`), holds a handle, or opens one; comments and strings never match. */
function touchesHippoDb(sf) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && DB_TOUCH_NAMES.has(node.text)) found = true;
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^(prepare|exec)$/.test(node.expression.name.text)
    ) {
      found = true;
    } else ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const isDbDefinitionFile = (f) =>
  Object.keys(DB_DEFINITION_FILES).some((k) => (k.endsWith('/') ? f.startsWith(k) : f === k));

/** Method names of an `interface SqliteLocal` in any src file: each is a write only hippo.db can run, so the list grows only by a hand edit of the baseline. */
function localMethods(sf) {
  const local = sf.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'SqliteLocal');
  return local ? local.members.map((m) => m.name.getText(sf)).sort() : [];
}

/** All numbers plus the per-file opener and prepare counts for src/, keys sorted, and the SqliteLocal method names. */
function measure() {
  const out = Object.fromEntries(NUMBERS.map((k) => [k, 0]));
  const byFile = {};
  const sqlByFile = {};
  const holdersByFile = {};
  const sqliteLocalMethods = [];
  let hippoDbOnlyRoutesList = [];
  const carrierFilesList = [];
  const storeFilesWithoutSqlList = [];
  const sites = { portImportsFromSql: [], buildsOutsideRoots: [], groupChecksInApi: [], portFunctionParams: [] };
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
      const holds = holdsHandle(sf);
      out.handleHoldersOutside += holds;
      if (holds > 0) holdersByFile[file] = holds;
      const prepares = countPrepares(sf);
      out.sqlOutside += prepares;
      if (prepares > 0) sqlByFile[file] = prepares;
    }
    if (file !== TX_OWNER) out.txLiterals += countTxLiterals(sf);
    if (file.startsWith('src/surface/cli/')) out.tenantResolvesInCli += countTenantResolves(sf);
    if (file.startsWith('src/surface/cli/') && !COMPOSITION_ROOTS.has(file)) {
      out.storeImportsInCli += countStoreImports(file, sf);
    }
    if (isDomain(file)) out.storeImportsInDomain += countDomainStoreImports(file, sf);
    if (file.startsWith('src/api/')) out.storeBranches += countStoreBranches(sf);
    out.twinFunctions += countTwins(sf);
    if (usesCarrier(sf)) carrierFilesList.push(file);
    if (file.startsWith('src/store/') && !isDbDefinitionFile(file) && !touchesHippoDb(sf)) {
      storeFilesWithoutSqlList.push(file);
    }
    if (file === 'src/surface/server/route-table.ts') {
      const routes = readRoutes(sf);
      out.routesNeedingHippoDb = routes.needsHippoDb;
      out.hippoDbOnlyRoutes = routes.hippoDbOnly.length;
      hippoDbOnlyRoutesList = routes.hippoDbOnly;
    }
    sqliteLocalMethods.push(...localMethods(sf));
    sites.portImportsFromSql.push(...portSqlImports(file, sf));
    sites.portFunctionParams.push(...portFunctionParams(file));
    if (buildsOutsideRootsHere(file)) sites.buildsOutsideRoots.push(...callsOf(file, sf, builderNames(file, sf)));
    if (checksGroupsHere(file)) sites.groupChecksInApi.push(...callsOf(file, sf, GROUP_CHECKS));
  }
  for (const k of Object.keys(sites)) if (NUMBERS.includes(k)) out[k] = sites[k].length;
  out.storeFilesWithoutSql = storeFilesWithoutSqlList.length;
  return {
    ...out,
    sites,
    storeFilesWithoutSqlList,
    openersOutsideByFile: byFile,
    sqlOutsideByFile: sqlByFile,
    handleHoldersOutsideByFile: holdersByFile,
    sqliteLocalMethods: sqliteLocalMethods.sort(),
    hippoDbOnlyRoutesList,
    carrierFiles: carrierFilesList.length,
    carrierFilesList,
  };
}

/** Numbers, files and SqliteLocal methods that went above the baseline, as [label, was, now]. */
function rises(base, cur) {
  const rose = [];
  // A key the baseline has never held is a first write, not a rise; once written it ratchets like the rest.
  const firstWrite = (k) => base !== null && base[k] === undefined;
  for (const k of NUMBERS) if (!firstWrite(k) && cur[k] > (base?.[k] ?? 0)) rose.push([k, base?.[k] ?? 0, cur[k]]);
  for (const site of cur.sites.portFunctionParams) rose.push([site, 'data only', 'takes a function, send it as data']);
  for (const key of BY_FILE_KEYS) {
    if (firstWrite(key)) continue;
    const was = base?.[key] ?? {};
    for (const [f, n] of Object.entries(cur[key])) if (n > (was[f] ?? 0)) rose.push([f, was[f] ?? 'new', n]);
  }
  if (!firstWrite('carrierFiles') && cur.carrierFiles > (base?.carrierFiles ?? 0)) {
    rose.push(['carrierFiles', base?.carrierFiles ?? 0, cur.carrierFiles]);
  }
  if (!firstWrite('carrierFilesList')) {
    for (const f of cur.carrierFilesList) {
      if (!(base?.carrierFilesList ?? []).includes(f)) {
        rose.push([f, 'not a carrier file', 'uses andThen, onStore or StoreReply']);
      }
    }
  }
  if (!firstWrite('storeFilesWithoutSqlList')) {
    for (const f of cur.storeFilesWithoutSqlList) {
      if (!(base?.storeFilesWithoutSqlList ?? []).includes(f)) {
        rose.push([f, 'unlisted', 'under src/store, runs no SQL']);
      }
    }
  }
  const listed = base?.sqliteLocalMethods ?? [];
  for (const m of cur.sqliteLocalMethods) {
    if (!listed.includes(m)) rose.push([`SqliteLocal.${m}`, 'unlisted', 'declared']);
  }
  const onlyListed = base?.hippoDbOnlyRoutesList ?? [];
  for (const r of cur.hippoDbOnlyRoutesList) {
    if (!onlyListed.includes(r)) rose.push([`hippoDbOnly ${r}`, 'unlisted', 'declared']);
  }
  return rose;
}

const strays = strayRecallRecords();
if (strays.length > 0) {
  console.error('A surface records a recall itself:');
  for (const hit of strays) console.error(`  ${hit}`);
  console.error(
    'Pass `recordAs` to retrieve() (or call retrieveWithCliCore()) instead: src/api/recall/finish.ts feeds the ring, counts the stats and books the token row.',
  );
  process.exit(1);
}

const loose = existsSync('src/store') ? tsFiles('src/store').flatMap(looseTenants) : [];
if (loose.length > 0) {
  console.error(`A store function or port method can be called without its tenant:\n  ${loose.join('\n  ')}`);
  console.error('Take `tenantId: string`, or `TenantId` if a real caller sends ALL_TENANTS (src/base/util/tenant.ts).');
  process.exit(1);
}

const current = measure();
/** The committed counts, or null when the file is absent; one read, so no exists-then-write race. */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

const args = process.argv.slice(2);
const baseline = readBaseline();
const total = NUMBERS.map((k) => `${k} ${current[k]}`).join(', ');

if (args.includes('--list')) {
  for (const k of NUMBERS) console.log(`${current[k]}\t${k}`);
  console.log(`${current.carrierFiles}\tcarrierFiles`);
  console.log(`${current.sites.portFunctionParams.length}\tportFunctionParams`);
  for (const [counter, where] of Object.entries(current.sites)) {
    for (const site of where) console.log(`${counter}\t${site}`);
  }
  for (const f of current.storeFilesWithoutSqlList) console.log(`no SQL\t${f}`);
  for (const site of folderFormsAboveAdapter()) console.log(`folderFormsAboveAdapter\t${site}`);
  for (const key of BY_FILE_KEYS) {
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
  const { sites: _sites, ...pinned } = current;
  writeFileSync(BASELINE, JSON.stringify(pinned, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total}.`);
  process.exit(0);
}

if (rose.length > 0) {
  console.error('Store-port counts rose above the baseline:');
  for (const [key, was, n] of rose) console.error(`  ${key}: ${was} -> ${n}`);
  console.error(
    'Reach the database through the store port instead of opening it, branching on the store, or adding a twin.',
  );
  console.error('`node scripts/check-store-port.mjs --list` shows every count.');
  process.exit(1);
}
// Only the SQLite adapter holds a folder.
const folderForms = folderFormsAboveAdapter();
if (folderForms.length > 0) {
  console.error(`Folder forms above src/store/sqlite: ${folderForms.length}, none allowed:`);
  for (const site of folderForms) console.error(`  ${site}`);
  console.error(
    'Take the store or the handle the caller holds; a folder form for a script or the eval kit goes in src/store/sqlite/folder-forms.ts.',
  );
  process.exit(1);
}
const strayTop = strayStoreTopFiles();
if (strayTop.length > 0) {
  console.error(`Files directly in src/store besides ${[...STORE_TOP_FILES].join(', ')}:`);
  for (const f of strayTop) console.error(`  ${f}`);
  console.error(
    'Put a store group and the SQL only it runs in src/store/sqlite/<feature>.ts, and a rule with no SQL in src/base.',
  );
  process.exit(1);
}
const fell =
  baseline &&
  (NUMBERS.some((k) => current[k] < (baseline[k] ?? 0)) ||
    BY_FILE_KEYS.some((key) => Object.entries(baseline[key] ?? {}).some(([f, n]) => (current[key][f] ?? 0) < n)) ||
    (baseline.sqliteLocalMethods ?? []).length > current.sqliteLocalMethods.length ||
    (baseline.hippoDbOnlyRoutesList ?? []).length > current.hippoDbOnlyRoutesList.length ||
    current.carrierFiles < (baseline.carrierFiles ?? 0));
if (fell) {
  console.log('Some counts fell below the baseline; run `node scripts/check-store-port.mjs --update` to lock that in.');
}
console.log(`Store-port ratchet OK: ${total}, none above ${BASELINE}.`);
