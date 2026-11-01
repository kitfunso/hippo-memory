#!/usr/bin/env node
// Builds the Z0 smoke toy repo (prereg stage 1) and its tasks file: one bug per module, one fix commit per task.
// Usage: node benchmarks/token-eval/smoke/make-toy.mjs <dir>  ->  <dir>/toy-repo, <dir>/tasks.json, <dir>/checks/
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// [task id, module, buggy source, fixed source, hidden test body, prompt]
const BUGS = [
  ['t1', 'slug', "(s) => s.trim().replace(/\\s+/g, '-')", "(s) => s.trim().toLowerCase().replace(/\\s+/g, '-')",
    "eq(m('Hello World'), 'hello-world');", "Slugs keep capital letters: slugify('Hello World') gives 'Hello-World', but our URLs must be all lowercase. Please fix slugify in src/slug.js."],
  ['n1', 'range', '(a, b) => { const out = []; for (let i = a; i < b; i++) out.push(i); return out; }', '(a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }',
    'eq(m(1, 3), [1, 2, 3]);', 'range(1, 3) returns [1, 2] but callers expect the end to be included: [1, 2, 3]. Please fix src/range.js.'],
  ['n2', 'clamp', '(x, lo, hi) => Math.min(lo, Math.max(hi, x))', '(x, lo, hi) => Math.min(hi, Math.max(lo, x))',
    'eq(m(15, 0, 10), 10); eq(m(-5, 0, 10), 0); eq(m(5, 0, 10), 5);', 'clamp(15, 0, 10) should give 10 but gives 0. Please fix src/clamp.js.'],
  ['a1', 'money', "(cents) => '$' + cents / 100", "(cents) => '$' + (cents / 100).toFixed(2)",
    "eq(m(1050), '$10.50'); eq(m(7), '$0.07');", 'formatCents(1050) prints $10.5 on invoices; it should print $10.50. Please fix src/money.js.'],
  ['a2', 'words', "(s) => s.split(' ').length", "(s) => s.split(/\\s+/).filter(Boolean).length",
    "eq(m('a  b'), 2); eq(m('  one two three '), 3);", "countWords('a  b') returns 3 when the text has double spaces; it should return 2. Please fix src/words.js."],
  ['f1-screen', 'initials', "(name) => name.split(' ').map((w) => w[0]).join('')", "(name) => name.split(' ').map((w) => w[0].toUpperCase()).join('')",
    "eq(m('ada lovelace'), 'AL');", "initials('ada lovelace') gives 'al'; initials should always be capitals. Please fix src/initials.js."],
  ['t-xa', 'pad', "(s, n) => s + ' '.repeat(Math.max(0, n - s.length))", "(s, n) => ' '.repeat(Math.max(0, n - s.length)) + s",
    "eq(m('7', 3), '  7');", "padLeft('7', 3) puts the spaces on the right ('7  '); it should give '  7'. Please fix src/pad.js."],
  ['t-xb', 'sum', '(xs) => xs.reduce((a, b) => a + b)', '(xs) => xs.reduce((a, b) => a + b, 0)',
    'eq(m([]), 0); eq(m([1, 2]), 3);', 'sum([]) throws a TypeError; the sum of an empty list should be 0. Please fix src/sum.js.'],
  ['t-xc', 'last', '(xs) => xs[xs.length]', '(xs) => xs[xs.length - 1]',
    'eq(m([1, 2, 3]), 3);', 'last([1, 2, 3]) returns undefined instead of 3. Please fix src/last.js.'],
  ['a-xa', 'odd', '(n) => n % 2 === 1', '(n) => Math.abs(n % 2) === 1',
    'eq(m(-3), true); eq(m(4), false);', 'isOdd(-3) returns false; negative odd numbers should count as odd. Please fix src/odd.js.'],
  ['a-xb', 'title', "(s) => s.charAt(0).toUpperCase() + s.slice(1)", "(s) => s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')",
    "eq(m('hello big world'), 'Hello Big World');", "titleCase('hello big world') gives 'Hello big world'; every word should start with a capital. Please fix src/title.js."],
  ['a-xc', 'unique', '(xs) => xs.filter((x, i) => xs.indexOf(x) !== i)', '(xs) => xs.filter((x, i) => xs.indexOf(x) === i)',
    'eq(m([1, 1, 2, 3, 3]), [1, 2, 3]);', 'unique([1, 1, 2, 3, 3]) returns [1, 3], only the repeats; it should return [1, 2, 3]. Please fix src/unique.js.'],
  ['b-xa', 'max', '(xs) => xs.reduce((a, b) => (b > a ? b : a), 0)', '(xs) => xs.reduce((a, b) => (b > a ? b : a), -Infinity)',
    'eq(m([-5, -2]), -2);', 'max([-5, -2]) returns 0, which is not even in the list; it should return -2. Please fix src/max.js.'],
  ['b-xb', 'trunc', "(s, n) => s.slice(0, n) + '...'", "(s, n) => (s.length <= n ? s : s.slice(0, n) + '...')",
    "eq(m('abc', 5), 'abc'); eq(m('abcdef', 3), 'abc...');", "truncate('abc', 5) gives 'abc...' though nothing was cut; short text should come back unchanged. Please fix src/trunc.js."],
  ['b-xc', 'chunk', '(xs, k) => { const out = []; for (let i = 0; i + k <= xs.length; i += k) out.push(xs.slice(i, i + k)); return out; }', '(xs, k) => { const out = []; for (let i = 0; i < xs.length; i += k) out.push(xs.slice(i, i + k)); return out; }',
    'eq(m([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);', 'chunk([1, 2, 3, 4, 5], 2) drops the 5; the last short chunk should be kept. Please fix src/chunk.js.'],
  ['xa-screen', 'avg', '(xs) => xs.reduce((a, b) => a + b, 0) / xs.length', '(xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)',
    'eq(m([]), 0); eq(m([2, 4]), 3);', 'avg([]) returns NaN; the average of an empty list should be 0. Please fix src/avg.js.'],
  ['xb-screen', 'capital', '(s) => s[0].toUpperCase() + s.slice(1)', "(s) => (s ? s[0].toUpperCase() + s.slice(1) : '')",
    "eq(m(''), ''); eq(m('abc'), 'Abc');", "capitalize('') throws; an empty string should come back empty. Please fix src/capital.js."],
  ['xc-screen', 'reverse', "(s) => s.split('').reverse().join('')", "(s) => s.split(' ').reverse().join(' ')",
    "eq(m('one two three'), 'three two one');", "reverseWords('one two three') reverses the letters; it should reverse the word order. Please fix src/reverse.js."],
];

const LESSONS = {
  f1: { id: 'f1-l1', rule: 'Put each change note in its own new file under changelog.d/ and never edit CHANGELOG.md by hand', reason: 'the release script builds CHANGELOG.md from those files', keyPhrase: 'changelog.d', check: { script: 'checks/fragment.mjs', args: ['changelog.d/'] } },
  xa: { id: 'xa-l1', rule: 'Every fix raises the patch number in the VERSION file by one', reason: 'the deploy job ships only when VERSION changes', keyPhrase: 'patch number', check: { script: 'checks/version.mjs', args: [] } },
  xb: { id: 'xb-l1', rule: 'Run node scripts/lint.mjs before you finish any change', reason: 'CI rejects every change the linter flags', keyPhrase: 'scripts/lint.mjs', check: { script: 'checks/ran.mjs', args: ['lint.mjs'] } },
  xc: { id: 'xc-l1', rule: 'Each fix adds a regression test as a new file under test/regress/', reason: 'the nightly job runs that folder against every old release', keyPhrase: 'test/regress', check: { script: 'checks/fragment.mjs', args: ['test/regress/'] } },
};

const BASE_FILES = {
  'README.md': '# toy-utils\n\nSmall string and list helpers. Each helper lives in its own file under src/.\n\nRun the tests with `node --test test/`.\n',
  'CHANGELOG.md': '# Changelog\n\n## 0.4.2\n- padLeft accepts numbers.\n\n## 0.4.1\n- First public release.\n',
  VERSION: '0.4.2\n',
  'package.json': '{\n  "name": "toy-utils",\n  "private": true,\n  "scripts": { "test": "node --test test/" }\n}\n',
  'scripts/lint.mjs': "// Fails on a line with trailing spaces or a tab in src/ and test/.\nimport * as fs from 'node:fs';\nimport * as path from 'node:path';\nlet bad = 0;\nfor (const dir of ['src', 'test']) {\n  if (!fs.existsSync(dir)) continue;\n  for (const f of fs.readdirSync(dir, { recursive: true })) {\n    const p = path.join(dir, String(f));\n    if (!p.endsWith('.js') || fs.statSync(p).isDirectory()) continue;\n    fs.readFileSync(p, 'utf8').split('\\n').forEach((line, i) => { if (/[ \\t]$/.test(line) || line.includes('\\t')) { bad++; console.log(`${p}:${i + 1}: whitespace`); } });\n  }\n}\nconsole.log(bad ? `${bad} problem(s)` : 'clean');\nprocess.exit(bad ? 1 : 0);\n",
  'test/basic.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('helpers load', () => { assert.equal(typeof require('../src/clamp.js'), 'function'); });\n",
};

const moduleFile = (mod, body) => `module.exports = ${body};\n`;
const hiddenTest = (mod, body) => `const assert = require('node:assert');\nconst m = require('../../src/${mod}.js');\nconst eq = (a, b) => assert.deepStrictEqual(a, b);\n${body}\nconsole.log('ok');\n`;

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function buildRepo(repo) {
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'toy@example.com'], ['user.name', 'Toy'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git('config', k, v);
  for (const [rel, text] of Object.entries(BASE_FILES)) write(repo, rel, text);
  for (const [, mod, buggy] of BUGS) write(repo, `src/${mod}.js`, moduleFile(mod, buggy));
  git('add', '.');
  git('commit', '-qm', 'toy-utils 0.4.2');
  const base = git('rev-parse', 'HEAD');
  const fixes = {};
  for (const [id, mod, , fixed, testBody] of BUGS) {
    git('checkout', '-q', '-b', `fix/${id}`, base);
    write(repo, `src/${mod}.js`, moduleFile(mod, fixed));
    write(repo, `test/hidden/${id}.test.js`, hiddenTest(mod, testBody));
    git('add', '.');
    git('commit', '-qm', `fix ${mod}`);
    fixes[id] = git('rev-parse', 'HEAD');
  }
  git('checkout', '-q', 'main');
  return { base, fixes };
}

function tasksFile(repo, { base, fixes }) {
  const bug = new Map(BUGS.map((b) => [b[0], b]));
  const fields = (id) => ({ id, baseRef: base, fixRef: fixes[id], prompt: bug.get(id)[5], testFiles: [`test/hidden/${id}.test.js`], test: `node test/hidden/${id}.test.js` });
  const task = (id, kind, lessonId) => {
    const t = { ...fields(id), kind };
    if (lessonId) Object.assign(t, { familyId: lessonId.split('-')[0], lessonId });
    return t;
  };
  const screen = fields;
  const family = (id, sequence, lessonSource) => ({ id, sequence, lessonSource, lessons: [LESSONS[id]], screen: screen(`${id}-screen`) });
  return {
    families: [family('f1', 'smoke-r', 'template'), family('xa', 'smoke-x', 'template'), family('xb', 'smoke-x', 'template'), family('xc', 'smoke-x', 'template')],
    sequences: [
      { id: 'smoke-r', cluster: 'toy', repo, fixedOrder: true, tasks: [task('t1', 'teach', 'f1-l1'), task('n1', 'no-lesson'), task('n2', 'no-lesson'), task('a1', 'apply', 'f1-l1'), task('a2', 'apply', 'f1-l1')] },
      { id: 'smoke-x', cluster: 'toy', repo, fixedOrder: true, set: 'X', tasks: [
        task('t-xa', 'teach', 'xa-l1'), task('t-xb', 'teach', 'xb-l1'), task('t-xc', 'teach', 'xc-l1'),
        task('a-xa', 'apply', 'xa-l1'), task('a-xb', 'apply', 'xb-l1'), task('a-xc', 'apply', 'xc-l1'),
        task('b-xa', 'apply', 'xa-l1'), task('b-xb', 'apply', 'xb-l1'), task('b-xc', 'apply', 'xc-l1'),
      ] },
    ],
  };
}

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node benchmarks/token-eval/smoke/make-toy.mjs <dir>');
  process.exit(2);
}
const out = path.resolve(dir);
const repo = path.join(out, 'toy-repo');
if (fs.existsSync(repo)) {
  console.error(`${repo} already exists; pick a fresh dir`);
  process.exit(2);
}
const refs = buildRepo(repo);
fs.cpSync(path.join(HERE, 'checks'), path.join(out, 'checks'), { recursive: true });
fs.writeFileSync(path.join(out, 'tasks.json'), JSON.stringify(tasksFile(repo.replaceAll('\\', '/'), refs), null, 2) + '\n');
console.log(`toy repo ${repo}, base ${refs.base.slice(0, 8)}, ${BUGS.length} fixes; tasks ${path.join(out, 'tasks.json')}`);
