#!/usr/bin/env node
// CI size gate. No file over 800 lines and no function over 50 in src/ (80 in scripts/) is the goal; existing offenders sit in
// .size-baseline.json and may shrink or go but never grow, and no new one may appear.
// Usage: check-size-ratchet.mjs [--list] [--update]. --update rewrites the baseline; run it only after shrinking offenders.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const BASELINE = '.size-baseline.json';
const FILE_LIMIT = 800;
const FUNCTION_LIMITS = { src: 50, scripts: 80 };
const SCAN_DIRS = Object.keys(FUNCTION_LIMITS);
const LIMITS_TEXT = `${FUNCTION_LIMITS.src} in src and ${FUNCTION_LIMITS.scripts} in scripts`;

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.([cm]?ts|mjs)$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.replace(/\\/g, '/'));
  }
  return out.sort();
}

function propName(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return '[computed]';
}

/** The variable or property an object literal is assigned to, so its methods read `handlers.run`. */
function ownerOf(obj) {
  const p = obj.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))) return propName(p.name);
  return undefined;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return 'call';
}

/** A line-number-free label for one function-like node; anonymous ones are named after what holds them. */
function localName(node) {
  const p = node.parent;
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? 'default';
  if (ts.isConstructorDeclaration(node)) return `${node.parent.name?.text ?? 'class'}.constructor`;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const kind = ts.isGetAccessor(node) ? 'get ' : ts.isSetAccessor(node) ? 'set ' : '';
    const owner = ts.isClassLike(p) ? p.name?.text ?? 'class' : ownerOf(p);
    return `${owner ? owner + '.' : ''}${kind}${propName(node.name)}`;
  }
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) {
    const owner = ts.isPropertyDeclaration(p) ? p.parent.name?.text : undefined;
    return `${owner ? owner + '.' : ''}${propName(p.name)}`;
  }
  if (ts.isPropertyAssignment(p)) {
    const owner = ownerOf(p.parent);
    return `${owner ? owner + '.' : ''}${propName(p.name)}`;
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return `${calleeName(p)}(callback)`;
  if (ts.isExportAssignment(p)) return 'default';
  return '(anonymous)';
}

const isFunctionLike = (n) =>
  (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && n.body !== undefined;

/** Every function in one file as [key, lines]; nested ones carry their parents' names and a #n when keys repeat. */
function functionLengths(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  const seen = new Map();
  const visit = (node, scope) => {
    let inner = scope;
    if (isFunctionLike(node)) {
      const path = [...scope, localName(node)].join(' > ');
      const n = (seen.get(path) ?? 0) + 1;
      seen.set(path, n);
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.end).line;
      out.push([`${file}:${path}${n > 1 ? ` #${n}` : ''}`, end - start + 1]);
      inner = [...scope, localName(node)];
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(sf, []);
  return out;
}

function physicalLines(text) {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Offenders under src/ and scripts/: { files: { path: lines }, functions: { 'path:name': lines } }, keys sorted. */
function findOffenders() {
  const files = {};
  const functions = {};
  for (const file of SCAN_DIRS.filter((d) => existsSync(d)).flatMap((d) => tsFiles(d))) {
    const text = readFileSync(file, 'utf8');
    const lines = physicalLines(text);
    if (lines > FILE_LIMIT) files[file] = lines;
    const limit = FUNCTION_LIMITS[file.split('/')[0]];
    for (const [key, n] of functionLengths(file, text)) if (n > limit) functions[key] = n;
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { files: sorted(files), functions: sorted(functions) };
}

const current = findOffenders();
const args = process.argv.slice(2);
const total = `${Object.keys(current.files).length} files over ${FILE_LIMIT} lines, ${Object.keys(current.functions).length} functions over ${LIMITS_TEXT}`;

if (args.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total}.`);
  process.exit(0);
}

if (args.includes('--list')) {
  for (const kind of ['files', 'functions']) {
    for (const [key, n] of Object.entries(current[kind]).sort(([, a], [, b]) => b - a)) console.log(`${n}\t${key}`);
  }
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const rose = [];
const fell = [];
for (const kind of ['files', 'functions']) {
  const was = baseline[kind] ?? {};
  for (const [key, n] of Object.entries(current[kind])) if (n > (was[key] ?? 0)) rose.push([key, was[key] ?? 'new', n]);
  for (const [key, n] of Object.entries(was)) if ((current[kind][key] ?? 0) < n) fell.push(key);
}

if (rose.length > 0) {
  console.error(`Files over ${FILE_LIMIT} lines or functions over ${LIMITS_TEXT} appeared or grew past the baseline:`);
  for (const [key, was, n] of rose) console.error(`  ${key}: ${was} -> ${n}`);
  console.error('Split the new code into a smaller function or module instead of growing an offender.');
  console.error('`node scripts/check-size-ratchet.mjs --list` shows every offender, longest first.');
  process.exit(1);
}
if (fell.length > 0) {
  console.log(`${fell.length} offenders shrank or went; run \`node scripts/check-size-ratchet.mjs --update\` to lock that in.`);
}
console.log(`Size ratchet OK: ${total}, none above ${BASELINE}.`);
