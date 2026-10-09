// Z0 checker identity: the bytes of every file a lesson checker loads, so a changed helper reads as a changed checker.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Whether to parse as an ES module; package.json picks the way a .js file runs, so it must parse both ways.
const AS_MODULE = { '.mjs': [true], '.cjs': [false], '.js': [false, true] };
// CommonJS runs any other ending as code, upper case included, so an unparsed file could hide imports.
const DATA = new Set(['.json', '.node']);
// require() takes any path that starts with two dots as relative, so "..lib/x.cjs" is local too.
const LOCAL = /^\.(?:[./\\]|$)/;
// import() reads these as URL syntax and require() as file-name characters, so one path cannot serve both.
const URL_SYNTAX = /[\\%?#\p{Cc}]| $/u;
const SCHEME = /^(?!node:)[a-z][a-z0-9+.-]*:/i;
// A package path with a ".." segment, plain or percent-written, ends at a local file outside the package.
const CLIMBS = /(?:^|[\\/])(?:\.|%2e){2}(?:[\\/]|$)/i;
const OWN_NAME = "a local import must be the file's own name, written with forward slashes, with its extension and no query";
const NEEDS_TS5 = 'checker identity needs the TypeScript 5 parser API';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isCode = (file) => Object.hasOwn(AS_MODULE, path.extname(file));
const lineError = (sf, pos, text) => new Error(`checker ${path.basename(sf.fileName)} line ${sf.getLineAndCharacterOfPosition(pos).line + 1}: ${text}`);

let typescript;

// Loaded on first use, so a harness script that never grades does not pay for the parser.
function parser() {
  if (typescript) return typescript;
  let ts;
  try {
    ts = createRequire(import.meta.url)('typescript');
  } catch (e) {
    throw new Error(`${NEEDS_TS5}, and the typescript package did not load (${e.code ?? e.message}); install the dev dependencies with npm install`);
  }
  // typescript 7 ships no parser API; a text scan in its place would bring the missed imports back.
  if (!(ts.createSourceFile instanceof Function && ts.forEachChild instanceof Function)) {
    throw new Error(`${NEEDS_TS5}; the installed typescript ${ts.version} does not have it`);
  }
  typescript = ts;
  return ts;
}

function parse(ts, file, text, asModule) {
  const sf = ts.createSourceFile(file, text, {
    languageVersion: ts.ScriptTarget.Latest,
    jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
    // A guessed goal reads a top-level await as a name, and the "/" or "`" after it then hides code.
    setExternalModuleIndicator: (f) => { f.externalModuleIndicator = asModule || undefined; },
  }, false);
  if (!Array.isArray(sf.parseDiagnostics)) throw new Error(`${NEEDS_TS5}; the installed typescript ${ts.version} does not report parse errors`);
  const [bad] = sf.parseDiagnostics;
  if (!bad) return sf;
  const way = asModule ? 'an ES module' : 'a CommonJS script';
  const both = path.extname(file) === '.js' ? '; a .js file must parse as CommonJS and as an ES module, so if it is valid one way, name it .cjs or .mjs' : '';
  throw lineError(sf, bad.start, `the harness cannot parse this file as ${way}, so it could miss an import (${ts.flattenDiagnosticMessageText(bad.messageText, ' ')})${both}`);
}

/** Whether a node loads a module by call: import(), import.source(), require(), (require)() or new require(). */
function isLoadCall(ts, n) {
  if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return false;
  let callee = n.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isMetaProperty(callee)) return callee.keywordToken === ts.SyntaxKind.ImportKeyword && callee.name.text !== 'meta';
  return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
}

// node reads "<!--" as a comment in CommonJS and the parser reads "x < !--y", so the two can part ways after it.
const isHtmlComment = (ts, sf, n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.LessThanToken && sf.text.startsWith('!--', n.operatorToken.end);
// node has no types, so a type in the tree means the parser took a path node does not; a bare "extends X" is the one type-kind node plain JavaScript has.
const isType = (ts, n) => ts.isTypeNode(n) && !(ts.isExpressionWithTypeArguments(n) && !n.typeArguments);

/** Every module specifier in the tree; a specifier that is not a plain string stops the load. */
function specifiers(ts, sf, asModule) {
  const found = [];
  const plain = (n, arg) => {
    if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      throw lineError(sf, n.getStart(sf), 'an import or require with a computed path cannot be hashed; write the path as a plain string');
    }
    found.push(arg.text);
  };
  // An explicit stack, since a long chained expression is deeper than the call stack.
  const stack = [sf];
  while (stack.length) {
    const n = stack.pop();
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) plain(n, n.moduleSpecifier);
    else if (isLoadCall(ts, n)) plain(n, n.arguments?.[0]);
    else if (isType(ts, n)) throw lineError(sf, n.getStart(sf), 'the parser reads a TypeScript type here and node has no types, so the two could load other files; remove the type, or put round brackets around an arrow function that follows ":"');
    else if (!asModule && isHtmlComment(ts, sf, n)) throw lineError(sf, n.operatorToken.pos, 'node reads "<!--" as a comment in CommonJS and the parser does not; put a space after "<"');
    ts.forEachChild(n, (c) => { stack.push(c); });
  }
  return found;
}

/** The local specifiers of one code file; packages and node: stay outside, and a path that cannot be hashed stops the load. */
function localImports(file, text) {
  const ts = parser();
  const specs = new Set();
  for (const asModule of AS_MODULE[path.extname(file)]) {
    for (const spec of specifiers(ts, parse(ts, file, text, asModule), asModule)) specs.add(spec);
  }
  return [...specs].filter((spec) => {
    if (LOCAL.test(spec)) return true;
    // A URL parser drops control characters and leading spaces before it reads the scheme.
    const isUrl = SCHEME.test(spec.replace(/\p{Cc}/gu, '').trimStart());
    if (!path.isAbsolute(spec) && !isUrl && !CLIMBS.test(spec)) return false;
    throw new Error(`checker ${path.basename(file)} imports "${spec}", which is an absolute path, a URL or a package path with ".."; import a local file by a relative path that starts with ./ or ../`);
  });
}

/** The real path and bytes a local specifier names; any failure tells the author how to write the import. */
function follow(from, spec) {
  const who = `checker ${path.basename(from)} imports "${spec}"`;
  if (URL_SYNTAX.test(spec)) throw new Error(`${who}, which holds a backslash, %, ?, #, a control character or a trailing space; ${OWN_NAME}`);
  const abs = path.resolve(path.dirname(from), spec);
  let real;
  let bytes;
  try {
    real = fs.realpathSync(abs);
    bytes = fs.readFileSync(real);
  } catch (e) {
    throw new Error(`${who}, but ${abs} cannot be read as a file (${e.code ?? e.message}); ${OWN_NAME}`);
  }
  if (isCode(real) || DATA.has(path.extname(real))) return [real, bytes];
  throw new Error(`${who}, and the harness cannot read the imports of that kind of file; an imported file must end in .js, .mjs, .cjs, .json or .node, in lower case`);
}

/** One [label, sha256] row per file the entry loads, where a label is the path from the entry's real folder and '' is the entry. */
export function checkerFiles(entry) {
  const root = fs.realpathSync(entry);
  if (!isCode(root)) throw new Error(`checker ${path.basename(root)} must end in .js, .mjs or .cjs, in lower case`);
  const files = new Map([[root, fs.readFileSync(root)]]);
  const queue = [root];
  while (queue.length) {
    const from = queue.pop();
    for (const spec of localImports(from, files.get(from).toString('utf8'))) {
      const [real, bytes] = follow(from, spec);
      if (files.has(real)) continue;
      files.set(real, bytes);
      if (isCode(real)) queue.push(real);
    }
  }
  const dir = path.dirname(root);
  return [...files]
    .map(([file, bytes]) => [file === root ? '' : path.relative(dir, file).split(path.sep).join('/'), sha256(bytes)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The entry's extension is in the hash because node runs the same bytes another way as .cjs and as .mjs. */
export function checkerIdentity(lesson) {
  const entry = fs.realpathSync(lesson.checkPath);
  return sha256(JSON.stringify([path.extname(entry), checkerFiles(entry), lesson.check.args ?? []]));
}
