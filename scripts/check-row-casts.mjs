#!/usr/bin/env node
// Fails when src/ casts a SQLite read to a row shape nothing proves. The SAFETY note sits once on the row type, so this
// check proves each cast instead: the SQL the statement runs must name every key of the row it is cast to.

import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { programFromConfig } from './check-floating-promises.mjs';

const READS = new Set(['get', 'all', 'iterate']);
const STATEMENT_TYPES = new Set(['StatementSyncLike', 'StatementSync']);
const WRAPPERS = new Set(['Array', 'ReadonlyArray', 'Iterable', 'IterableIterator']);
// The nodes the anti-slop lint rule looks above for a SAFETY note, so a cast passes here exactly where it passes there.
const OWNER_KINDS = new Set([
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.VariableStatement,
]);
// A part of the SQL known only at run time reads as this, which matches no column name.
const UNKNOWN = '\0';
// Read from node:sqlite; a value pragma such as `PRAGMA user_version` answers one column named after itself.
const PRAGMA_COLUMNS = { table_info: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'] };
// Deep enough for a builder that calls a builder, shallow enough that a recursive one stops.
const MAX_DEPTH = 12;

const hasSafety = (text, from, to) =>
  [...text.slice(from, to).matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)].some((c) => /\bSAFETY\s*:/.test(c[0]));

/** A SAFETY comment just before the cast or one of its ancestors up to the owning statement, as the lint rule looks. */
function noteAtCast(cast, sf) {
  for (let node = cast; node; node = node.parent) {
    const comments = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
    const before = comments.filter((c) => c.end <= cast.getStart(sf));
    if (before.some((c) => /\bSAFETY\s*:/.test(sf.text.slice(c.pos, c.end)))) return true;
    if (OWNER_KINDS.has(node.kind) || node.parent?.kind === ts.SyntaxKind.SourceFile) return false;
  }
  return false;
}

/** The row type under `| undefined`, `| null`, `[]` and the iterable wrappers. */
function rowType(type) {
  if (ts.isParenthesizedTypeNode(type)) return rowType(type.type);
  if (ts.isArrayTypeNode(type)) return rowType(type.elementType);
  if (ts.isUnionTypeNode(type)) {
    const rest = type.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    return rest.length === 1 ? rowType(rest[0]) : type;
  }
  if (ts.isTypeReferenceNode(type) && WRAPPERS.has(type.typeName.getText()) && type.typeArguments?.length === 1) {
    return rowType(type.typeArguments[0]);
  }
  return type;
}

const unwrap = (node) =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;

/** The top-level comma-separated items after the first top-level `keyword`, up to `stop` or the end. */
function topLevelItems(sql, keyword, stop) {
  let depth = 0;
  let start = -1;
  let end = sql.length;
  const cuts = [];
  for (let i = 0; i < sql.length && end === sql.length; i++) {
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === ',' && start >= 0) cuts.push(i);
    else if (depth === 0 && /\w/.test(c) && !/\w/.test(sql[i - 1] ?? '')) {
      const word = /^\w+/.exec(sql.slice(i))[0].toUpperCase();
      if (start < 0 && word === keyword) start = i + word.length;
      else if (start >= 0 && word === stop) end = i;
    }
  }
  if (start < 0) return undefined;
  return [start, ...cuts].map((from, n) => sql.slice(n === 0 ? from : from + 1, cuts[n] ?? end).trim());
}

/** The column names a statement answers: RETURNING, else the first top-level SELECT, else a PRAGMA; `*` is a wildcard. */
export function selectNames(sql) {
  const items = topLevelItems(sql, 'RETURNING', ';') ?? topLevelItems(sql, 'SELECT', 'FROM');
  if (!items) {
    const pragma = /^\s*PRAGMA\s+(\w+)\s*(\()?/i.exec(sql);
    if (!pragma) return undefined;
    return pragma[2] ? PRAGMA_COLUMNS[pragma[1].toLowerCase()] : [pragma[1]];
  }
  return items.flatMap((item) => {
    const alias = /\bAS\s+["`]?(\w+)["`]?$/i.exec(item);
    if (alias) return [alias[1]];
    if (/(^|\.)\*$/.test(item)) return ['*'];
    // An item built from text known only at run time names nothing this check can see.
    const bare = item.includes(UNKNOWN) ? null : /(?:^|[\s.])["`]?(\w+)["`]?$/.exec(item);
    return bare ? [bare[1]] : [];
  });
}

/** Reads the SQL text of TypeScript expressions as far as constants, builders and string methods allow. */
function sqlReader(checker) {
  const symbolOf = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };

  /** The initializer of a `const`, or of a `let` that is only ever appended to, which reads as a prefix. */
  function boundValue(id) {
    const decl = symbolOf(id)?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    const flags = ts.getCombinedNodeFlags(decl);
    if (flags & ts.NodeFlags.Const) return { init: unwrap(decl.initializer), prefix: false };
    if (!(flags & ts.NodeFlags.Let)) return undefined;
    let reassigned = false;
    const symbol = symbolOf(decl.name);
    const walk = (n) => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(n.left) &&
        symbolOf(n.left) === symbol
      ) {
        reassigned = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(decl.getSourceFile());
    return reassigned ? undefined : { init: unwrap(decl.initializer), prefix: true };
  }

  /** The called function and the one expression it returns, when it has exactly one `return`. */
  function called(call) {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const decl = symbolOf(call.expression)?.valueDeclaration;
    const fn = decl && ts.isVariableDeclaration(decl) ? boundValue(decl.name)?.init : decl;
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.body) {
      return undefined;
    }
    if (!ts.isBlock(fn.body)) return { fn, body: unwrap(fn.body) };
    const returns = [];
    const walk = (n) => {
      if (ts.isReturnStatement(n)) returns.push(n);
      else if (!ts.isFunctionLike(n)) ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn.body, walk);
    return returns.length === 1 && returns[0].expression ? { fn, body: unwrap(returns[0].expression) } : undefined;
  }
  const returned = (call) => called(call)?.body;

  /** The node an expression stands for: a constant's initializer or a builder's returned expression. */
  function source(expr, depth) {
    const node = unwrap(expr);
    if (depth > MAX_DEPTH) return undefined;
    if (ts.isIdentifier(node)) {
      const bound = boundValue(node);
      return bound && !bound.prefix ? source(bound.init, depth + 1) : node;
    }
    if (ts.isCallExpression(node)) {
      const body = returned(node);
      return body ? source(body, depth + 1) : node;
    }
    return node;
  }

  /** The strings of a constant array, through spreads and `.map` over a one-parameter arrow, or undefined. */
  function strings(expr, env, depth) {
    const node = source(expr, depth);
    if (!node) return undefined;
    if (ts.isArrayLiteralExpression(node)) {
      const out = [];
      for (const el of node.elements) {
        const part = ts.isSpreadElement(el) ? strings(el.expression, env, depth + 1) : [text(el, env, depth + 1)];
        if (!part || part.some((p) => p.includes(UNKNOWN))) return undefined;
        out.push(...part);
      }
      return out;
    }
    const call = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node : undefined;
    if (call?.expression.name.text === 'split' && call.arguments.length === 1) {
      const whole = text(call.expression.expression, env, depth + 1);
      const sep = text(call.arguments[0], env, depth + 1);
      return whole.includes(UNKNOWN) || sep.includes(UNKNOWN) ? undefined : whole.split(sep);
    }
    const fn = call?.expression.name.text === 'map' ? unwrap(call.arguments[0] ?? call) : undefined;
    if (!fn || !ts.isArrowFunction(fn) || fn.parameters.length !== 1 || ts.isBlock(fn.body)) return undefined;
    const param = fn.parameters[0].name.getText();
    const base = strings(call.expression.expression, env, depth + 1);
    return base?.map((value) => text(fn.body, new Map([...env, [param, value]]), depth + 1));
  }

  /** The SQL text an expression spells, with UNKNOWN for each part known only at run time. */
  function text(expr, env = new Map(), depth = 0) {
    const node = unwrap(expr);
    if (depth > MAX_DEPTH) return UNKNOWN;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return (
        node.head.text + node.templateSpans.map((s) => text(s.expression, env, depth + 1) + s.literal.text).join('')
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return text(node.left, env, depth + 1) + text(node.right, env, depth + 1);
    }
    if (ts.isIdentifier(node)) {
      if (env.has(node.text)) return env.get(node.text);
      const bound = boundValue(node);
      if (!bound) return UNKNOWN;
      return text(bound.init, env, depth + 1) + (bound.prefix ? UNKNOWN : '');
    }
    if (ts.isPropertyAccessExpression(node)) {
      const obj = source(node.expression, depth + 1);
      const prop =
        obj && ts.isObjectLiteralExpression(obj)
          ? obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === node.name.text)
          : undefined;
      return prop ? text(prop.initializer, env, depth + 1) : UNKNOWN;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') {
        const parts = strings(node.expression.expression, env, depth + 1);
        const sep = node.arguments.length === 0 ? ',' : text(node.arguments[0], env, depth + 1);
        return parts && !sep.includes(UNKNOWN) ? parts.join(sep) : UNKNOWN;
      }
      const target = called(node);
      if (!target) return UNKNOWN;
      // Each parameter reads as its argument's text, so a builder called with literals spells its whole result.
      const args = target.fn.parameters.map((p, i) => [
        p.name.getText(),
        node.arguments[i] ? text(node.arguments[i], env, depth + 1) : UNKNOWN,
      ]);
      return text(target.body, new Map(args), depth + 1);
    }
    return UNKNOWN;
  }

  /** The column names the SQL answers; a choice between two statements answers only the names both share. */
  function names(expr, depth = 0) {
    const node = source(expr, depth);
    if (!node) return undefined;
    if (ts.isConditionalExpression(node)) {
      const a = names(node.whenTrue, depth + 1);
      const b = names(node.whenFalse, depth + 1);
      if (!a || !b) return undefined;
      if (a.includes('*')) return b;
      return b.includes('*') ? a : a.filter((n) => b.includes(n));
    }
    return selectNames(text(node, new Map(), depth));
  }

  /** The SQL a read runs: `db.prepare(sql)`, `cachedStatement(db, sql)`, or a `const` holding either. */
  function statementSql(receiver) {
    const node = unwrap(receiver);
    if (ts.isIdentifier(node)) {
      const bound = boundValue(node);
      return bound && !bound.prefix ? statementSql(bound.init) : undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'prepare') return node.arguments[0];
    if (ts.isIdentifier(callee) && callee.text === 'cachedStatement') return node.arguments[1];
    return undefined;
  }

  return { symbolOf, names, statementSql };
}

// Library generics whose first argument is the row the keys come from.
const KEY_KEEPERS = new Set(['Omit', 'Pick', 'Partial', 'Readonly', 'Required']);

/** Each named type the row's keys come from, so its declaration can be held to the one SAFETY note. */
function namedParts(sql, row) {
  const parts = [];
  const walk = (node) => {
    if (ts.isParenthesizedTypeNode(node)) walk(node.type);
    else if (ts.isIntersectionTypeNode(node)) node.types.forEach(walk);
    else if (ts.isIndexedAccessTypeNode(node)) walk(node.objectType);
    else if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText();
      const symbol = sql.symbolOf(node.typeName);
      const decl = symbol?.declarations?.[0];
      if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) parts.push({ name });
      else if (decl && !decl.getSourceFile().isDeclarationFile) parts.push({ name, decl });
      else if (KEY_KEEPERS.has(name) && node.typeArguments?.length) walk(node.typeArguments[0]);
    }
  };
  walk(row);
  return parts;
}

/** Why a cast with no note of its own does not hold, or undefined when it does. */
function rowCastProblem(checker, sql, cast, read) {
  const row = rowType(cast.type);
  for (const { name, decl } of namedParts(sql, row)) {
    if (!decl) return `${name} is a type parameter, so the row shape is unknown here`;
    const sf = decl.getSourceFile();
    if (!hasSafety(sf.text, decl.getFullStart(), decl.getStart(sf))) return `${name} carries no SAFETY note`;
  }
  // A row whose keys are all optional still claims each one, since a read with none of them would fit any SQL.
  const props = checker.getTypeFromTypeNode(row).getProperties();
  const required = props.filter((p) => !(p.flags & ts.SymbolFlags.Optional));
  const keys = (required.length > 0 ? required : props).map((p) => p.getName());
  if (keys.length === 0) return 'the row type has no key this check can see';
  const statement = sql.statementSql(read.expression.expression);
  if (!statement) return 'the statement is not prepared from SQL in view';
  const answered = sql.names(statement);
  if (!answered) return 'the SQL answers no columns this check can read';
  if (answered.includes('*')) return undefined;
  const missing = keys.filter((k) => !answered.includes(k));
  return missing.length ? `the SQL does not name ${missing.join(', ')}` : undefined;
}

/**
 * Every get/all/iterate cast in the program's files under `srcDir`, with why it fails when it has no SAFETY note of its own.
 * @param {ts.Program} program
 * @param {string} srcDir
 * @returns {{ file: string, line: number, noted: boolean, problem: string | undefined }[]}
 */
export function findRowCasts(program, srcDir) {
  const root = srcDir.replace(/\\/g, '/').replace(/\/$/, '');
  const checker = program.getTypeChecker();
  const sql = sqlReader(checker);
  const casts = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(`${root}/`)) continue;
    const visit = (node) => {
      const read = ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ? node.expression : undefined;
      if (
        read &&
        ts.isCallExpression(read) &&
        ts.isPropertyAccessExpression(read.expression) &&
        READS.has(read.expression.name.text)
      ) {
        const receiver = checker.getTypeAtLocation(read.expression.expression).getSymbol()?.getName() ?? '';
        const problem = STATEMENT_TYPES.has(receiver) ? rowCastProblem(checker, sql, node, read) : 'not a SQLite read';
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        casts.push({ file: sf.fileName.slice(root.length + 1), line: line + 1, noted: noteAtCast(node, sf), problem });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return casts.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const casts = findRowCasts(programFromConfig('tsconfig.json'), `${process.cwd()}/src`);
  if (process.argv.includes('--report')) {
    const tag = (c) => `${c.noted ? 'noted' : 'bare'}\t${c.problem ?? 'holds'}`;
    for (const c of casts) console.log(`src/${c.file}:${c.line}\t${tag(c)}`);
    process.exit(0);
  }
  const bad = casts.filter((c) => c.problem && !c.noted);
  if (bad.length > 0) {
    console.error('\nSQLite row casts in src/ that nothing proves:');
    for (const c of bad) console.error(`  src/${c.file}:${c.line}  ${c.problem}`);
    console.error(
      '\nFix: name every key the row needs in its SQL, or say why the cast holds in a SAFETY note at the cast.\n',
    );
    process.exit(1);
  }
  console.log(`Every SQLite row cast in src/ names the keys it reads (${casts.length} casts). OK.`);
}
