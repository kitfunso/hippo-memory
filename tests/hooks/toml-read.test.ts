import { describe, it, expect } from 'vitest';
import { readToml, type TomlStatement, type TomlValue } from '../../src/surface/hooks-install/rules/toml-read.js';

const scalar = (text: string): TomlValue => ({ scalar: text });
const key = (path: string[], value: TomlValue, line = 0, endLine = line): TomlStatement => ({
  kind: 'key',
  path,
  value,
  line,
  endLine,
});
const table = (path: string[], line = 0): TomlStatement => ({ kind: 'table', path, line });

const READS: [string, string, TomlStatement[]][] = [
  [
    'bare, basic and literal keys, dotted with spaces and tabs around the dots',
    `a-b_1 . "c d"\t.\t'e' = 1\n`,
    [key(['a-b_1', 'c d', 'e'], scalar('1'))],
  ],
  [
    'escaped keys',
    '"\\u0068ippo" = 1\n"\\U00000068ippo" = 2\n',
    [key(['hippo'], scalar('1')), key(['hippo'], scalar('2'), 1)],
  ],
  ['a literal key with a backslash, taken as written', "'C:\\repo' = 1\n", [key(['C:\\repo'], scalar('1'))]],
  [
    'every basic-string escape',
    'e = "\\b\\t\\n\\f\\r\\e\\"\\\\\\x41\\u00e9\\U0001F600"\n',
    [key(['e'], '\b\t\n\f\r\x1b"\\A\u00e9\u{1F600}')],
  ],
  ['a literal string with backslashes', "p = 'C:\\Users\\me'\n", [key(['p'], 'C:\\Users\\me')]],
  [
    'table and array-table headers with spaces and a comment',
    '[ a . "b" ] # c\n[[x.y]]\nk = 1 # note\n',
    [table(['a', 'b']), { kind: 'array-table', path: ['x', 'y'], line: 1 }, key(['x', 'y', 'k'], scalar('1'), 2)],
  ],
  ['a header with a Windows path in its comment', '[projects] # C:\\Users\n', [table(['projects'])]],
  [
    'a literal key in a header',
    "[projects.'C:\\repo']\ntrusted = true\n",
    [table(['projects', 'C:\\repo']), key(['projects', 'C:\\repo', 'trusted'], scalar('true'), 1)],
  ],
  [
    'a multi-line basic string: escapes, a line-ending backslash and two quotes before the close',
    's = """\none \\\n    two\nthree ""\\u0041"""""\n',
    [key(['s'], 'one two\nthree ""A""', 0, 3)],
  ],
  ['a multi-line literal string', "l = '''\nC:\\x\n'''\n", [key(['l'], 'C:\\x\n', 0, 2)]],
  [
    'a multi-line basic string that holds hippo table lines',
    'note = """\n[mcp_servers.hippo]\ncommand = "hippo"\n"""\nmodel = "x"\n',
    [key(['note'], '[mcp_servers.hippo]\ncommand = "hippo"\n', 0, 3), key(['model'], 'x', 4)],
  ],
  [
    'an array over lines with comments and a trailing comma',
    'a = [ # open\n  "x", # one\n  \'y\',\n]\n',
    [key(['a'], ['x', 'y'], 0, 3)],
  ],
  [
    'a nested array with [1, 2], lines',
    'n = [\n  [1, 2],\n  [3, 4],\n]\n',
    [
      key(
        ['n'],
        [
          [scalar('1'), scalar('2')],
          [scalar('3'), scalar('4')],
        ],
        0,
        3,
      ),
    ],
  ],
  [
    'an inline table with a dotted key and a nested table',
    't = { a = "x", b.c = 1, d = { e = [true] } }\n',
    [key(['t'], { a: 'x', b: { c: scalar('1') }, d: { e: [scalar('true')] } })],
  ],
  [
    'an inline table over lines with a comment and a trailing comma',
    't = {\n  a = 1, # c\n  b = 2,\n}\n',
    [key(['t'], { a: scalar('1'), b: scalar('2') }, 0, 3)],
  ],
  [
    'numbers, bools, dates and times, one date-time with a space',
    'i = -1_000\nf = 6.626e-34\nh = 0xdead_beef\nb = false\nd = 1979-05-27\nt = 07:32:00\n' +
      'dt = 1979-05-27 07:32:00 # local\nz = 1979-05-27T00:32:00.999-07:00\nn = -inf\n',
    [
      key(['i'], scalar('-1_000')),
      key(['f'], scalar('6.626e-34'), 1),
      key(['h'], scalar('0xdead_beef'), 2),
      key(['b'], scalar('false'), 3),
      key(['d'], scalar('1979-05-27'), 4),
      key(['t'], scalar('07:32:00'), 5),
      key(['dt'], scalar('1979-05-27 07:32:00'), 6),
      key(['z'], scalar('1979-05-27T00:32:00.999-07:00'), 7),
      key(['n'], scalar('-inf'), 8),
    ],
  ],
  ['a backslash in a comment', '# C:\\x = 1\na = 1 # \\q\n', [key(['a'], scalar('1'), 1)]],
  [
    'CRLF line ends, a blank line and no final line end',
    'a = 1\r\n\r\n[b]\r\nc = "x"',
    [key(['a'], scalar('1')), table(['b'], 2), key(['b', 'c'], 'x', 3)],
  ],
  ['a BOM before the first line', '\uFEFFa = 1\n', [key(['a'], scalar('1'))]],
];

const NOT_READ: [string, string][] = [
  ['a """ string open at the end', 'a = """\nb\n'],
  ["a ''' string open at the end", "a = '''\nb\n"],
  ['a basic string open at the end of its line', 'a = "x\nb = 1\n'],
  ['an array open at the end', 'a = [\n  1,\n'],
  ['an inline table open at the end', 't = { a = 1'],
  ['a "\\q" key', '"\\q" = 1\n'],
  ['a "\\q" value', 'a = "\\q"\n'],
  ['an unterminated header', '[a.b\n'],
  ['text after a header', '[a] b\n'],
  ['a key with no =', 'a b = 1\n'],
  ['text after a value', 'a = 1 2\n'],
  ['a string and more text', 'a = "x" y\n'],
  ['a bare word as a value', 'a = hello\n'],
  ['six quotes at the close of a multi-line string', 'a = """x""""""\n'],
  ['a key twice in an inline table', 't = { a = 1, a = 2 }\n'],
  ['a carriage return with no line feed', 'a = 1\rb = 2\n'],
];

describe('readToml', () => {
  it.each(READS)('reads %s', (_label, text, statements) => {
    expect(readToml(text)).toEqual({ statements });
  });

  it.each(NOT_READ)('returns null for %s', (_label, text) => {
    expect(readToml(text)).toBeNull();
  });
});
