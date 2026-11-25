import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Homes } from '../../src/base/util/agent-homes.js';
import { parseJson, type JsonObject, type JsonValue } from '../../src/base/util/json.js';
import {
  installMcpConfigHost,
  isMcpConfigHostPresent,
  uninstallMcpConfigHost,
} from '../../src/surface/hooks-install/mcp-config.js';
import { grokStatus } from '../../src/surface/hooks-install/rules/grok-build.js';
import { isMcpFailure, MCP_CONFIG_HOSTS, type McpConfigRow } from '../../src/surface/hooks-install/rules/mcp-config.js';

const CMD = process.platform === 'win32' ? 'hippo.cmd' : 'hippo';
const BOM = String.fromCodePoint(0xfeff);
const JSON_HOSTS = ['junie', 'antigravity', 'muse-code'] as const;
const KEY = {
  junie: 'mcpServers',
  antigravity: 'mcpServers',
  'muse-code': 'mcp_servers',
} as const satisfies Record<string, string>;
const SERVER = {
  junie: { command: CMD, args: ['mcp'] },
  antigravity: { command: CMD, args: ['mcp'] },
  'muse-code': { transport: 'stdio', command: CMD, args: ['mcp'], mode: 'optional' },
} satisfies Record<string, JsonObject>;
const USER_SERVER = { command: 'npx', args: ['their-server'] };
const TABLE = `[mcp_servers.hippo]\ncommand = "${CMD}"\nargs = ["mcp"]\n`;
const tableWith = (eol: string): string => TABLE.replace(/\n/g, eol);
const HAND_WRITTEN: [string, JsonObject][] = [
  ['hippo with mcp', { command: 'hippo', args: ['mcp'] }],
  ['a Windows path to hippo.cmd', { command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\hippo.cmd', args: ['mcp'] }],
  ['npx with the package', { command: 'npx', args: ['-y', 'hippo-memory', 'mcp'] }],
  ['npx with a pinned version', { command: 'npx', args: ['-y', 'hippo-memory@3.16.0', 'mcp'] }],
];
const NOT_HIPPO_MCP: [string, JsonObject][] = [
  ['hippo serve', { command: 'hippo', args: ['serve'] }],
  ['hippo recall', { command: 'hippo', args: ['recall'] }],
  ['npx with another package', { command: 'npx', args: ['-y', 'other-memory', 'mcp'] }],
];
const FILE_STYLES: [string, string, string, string, string][] = [
  ['a BOM, CRLF and four spaces', BOM, '\r\n', '    ', '\r\n'],
  ['tabs', '', '\n', '\t', '\n'],
  ['no final line break', '', '\n', '  ', ''],
];

let home: string;
let homes: Homes;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-hosts-'));
  homes = { home, env: {} };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function rowNamed(name: string): McpConfigRow {
  const found = MCP_CONFIG_HOSTS.find((row) => row.name === name);
  if (found === undefined) throw new Error(`no MCP config row named ${name}`);
  return found;
}

const fileOf = (name: string): string => rowNamed(name).file(homes);
const install = (name: string) => installMcpConfigHost(rowNamed(name), homes);
const uninstall = (name: string) => uninstallMcpConfigHost(rowNamed(name), homes);
const read = (file: string): string => fs.readFileSync(file, 'utf8');
const readJson = (file: string): JsonValue => parseJson(read(file).replace(/^﻿/, ''));

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('the host rows', () => {
  it('name the four hosts and the files hippo edits', () => {
    expect(MCP_CONFIG_HOSTS.map((row) => row.name)).toEqual(['junie', 'antigravity', 'grok-build', 'muse-code']);
    expect(fileOf('junie')).toBe(path.join(home, '.junie', 'mcp', 'mcp.json'));
    expect(fileOf('antigravity')).toBe(path.join(home, '.gemini', 'config', 'mcp_config.json'));
    expect(fileOf('grok-build')).toBe(path.join(home, '.grok', 'config.toml'));
    expect(fileOf('muse-code')).toBe(path.join(home, '.config', 'muse', 'settings.json'));
  });

  it('read HOME before the profile folder', () => {
    const elsewhere: Homes = { home: path.join(home, 'profile'), env: { HOME: home } };
    expect(rowNamed('junie').file(elsewhere)).toBe(fileOf('junie'));
  });

  it('put Muse Code under XDG_CONFIG_HOME when it is set', () => {
    const xdg = path.join(home, 'xdg');
    const withXdg: Homes = { home, env: { XDG_CONFIG_HOME: xdg } };
    expect(rowNamed('muse-code').file(withXdg)).toBe(path.join(xdg, 'muse', 'settings.json'));
    expect(rowNamed('muse-code').dirs(withXdg)).toEqual([path.join(xdg, 'muse')]);
  });

  it('count a host as present only when one of its folders exists', () => {
    for (const row of MCP_CONFIG_HOSTS) expect(isMcpConfigHostPresent(row, homes)).toBe(false);
    fs.mkdirSync(path.join(home, '.gemini'));
    expect(isMcpConfigHostPresent(rowNamed('antigravity'), homes)).toBe(false);
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'));
    expect(isMcpConfigHostPresent(rowNamed('antigravity'), homes)).toBe(true);
    fs.mkdirSync(path.join(home, '.junie'));
    fs.mkdirSync(path.join(home, '.grok'));
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
    for (const name of ['junie', 'grok-build', 'muse-code']) {
      expect(isMcpConfigHostPresent(rowNamed(name), homes)).toBe(true);
    }
  });

  it('count a file in place of the folder as absent', () => {
    write(path.join(home, '.junie'), 'not a folder');
    expect(isMcpConfigHostPresent(rowNamed('junie'), homes)).toBe(false);
  });
});

describe.each(JSON_HOSTS)('%s JSON host', (name) => {
  const entry = (): JsonObject => ({ [KEY[name]]: { hippo: SERVER[name] } });

  it('adds to a missing file, then reports present', () => {
    expect(install(name)).toEqual({ name, file: fileOf(name), status: 'added' });
    const written = readJson(fileOf(name));
    expect(written).toMatchObject(entry());
    expect(install(name).status).toBe('present');
    expect(readJson(fileOf(name))).toEqual(written);
  });

  it('keeps a user "hippo" entry: user-owned on add and on remove', () => {
    const text = JSON.stringify({ [KEY[name]]: { hippo: USER_SERVER } });
    write(fileOf(name), text);
    expect(install(name).status).toBe('user-owned');
    expect(uninstall(name).status).toBe('user-owned');
    expect(read(fileOf(name))).toBe(text);
  });

  it('keeps an entry with a key hippo did not write that still runs hippo mcp', () => {
    const text = JSON.stringify({ [KEY[name]]: { hippo: { ...SERVER[name], env: { A: 'b' } } } });
    write(fileOf(name), text);
    expect(install(name).status).toBe('kept');
    expect(uninstall(name).status).toBe('kept');
    expect(read(fileOf(name))).toBe(text);
  });

  it.each(HAND_WRITTEN)(
    'counts a "hippo-memory" entry with %s as hippo\'s: kept, no byte changed',
    (_label, server) => {
      const text = JSON.stringify({ [KEY[name]]: { 'hippo-memory': server } });
      write(fileOf(name), text);
      expect(install(name).status).toBe('kept');
      expect(uninstall(name).status).toBe('kept');
      expect(read(fileOf(name))).toBe(text);
    },
  );

  it.each(HAND_WRITTEN.slice(1))(
    'counts a "hippo" entry with %s as hippo\'s: kept, no byte changed',
    (_label, server) => {
      const text = JSON.stringify({ [KEY[name]]: { hippo: server } });
      write(fileOf(name), text);
      expect(install(name).status).toBe('kept');
      expect(uninstall(name).status).toBe('kept');
      expect(read(fileOf(name))).toBe(text);
    },
  );

  it.each(NOT_HIPPO_MCP)('does not count a "hippo-memory" entry running %s: install adds "hippo"', (_label, server) => {
    const before = { [KEY[name]]: { 'hippo-memory': server } };
    write(fileOf(name), JSON.stringify(before));
    expect(install(name).status).toBe('added');
    expect(readJson(fileOf(name))).toMatchObject({ [KEY[name]]: { 'hippo-memory': server, hippo: SERVER[name] } });
    expect(uninstall(name).status).toBe('removed');
    expect(readJson(fileOf(name))).toEqual(before);
  });

  it.each(FILE_STYLES)('keeps the file style on install and uninstall: %s', (_label, bom, eol, indent, end) => {
    const dress = (value: JsonObject): string => bom + JSON.stringify(value, null, indent).replace(/\n/g, eol) + end;
    const original = dress({ theme: 'dark', [KEY[name]]: { theirs: USER_SERVER } });
    write(fileOf(name), original);
    expect(install(name).status).toBe('added');
    expect(read(fileOf(name))).toBe(
      dress({ theme: 'dark', [KEY[name]]: { theirs: USER_SERVER, hippo: SERVER[name] } }),
    );
    expect(install(name).status).toBe('present');
    expect(uninstall(name).status).toBe('removed');
    expect(read(fileOf(name))).toBe(original);
  });

  it('reports unreadable for a file with comments', () => {
    const text = `// mine\n{ "${KEY[name]}": {} }\n`;
    write(fileOf(name), text);
    expect(install(name).status).toBe('unreadable');
    expect(uninstall(name).status).toBe('unreadable');
    expect(read(fileOf(name))).toBe(text);
  });

  it('reports unreadable when the server table is not an object', () => {
    const text = JSON.stringify({ [KEY[name]]: [] });
    write(fileOf(name), text);
    expect(install(name).status).toBe('unreadable');
    expect(read(fileOf(name))).toBe(text);
  });

  it('removes its own entry and drops an empty server table', () => {
    install(name);
    expect(uninstall(name).status).toBe('removed');
    expect(readJson(fileOf(name))).not.toHaveProperty(KEY[name]);
    expect(uninstall(name).status).toBe('absent');
  });

  it('reports absent for a missing file and writes nothing', () => {
    expect(uninstall(name).status).toBe('absent');
    expect(fs.existsSync(fileOf(name))).toBe(false);
  });

  it('keeps every other server and top-level key', () => {
    const before = { theme: 'dark', [KEY[name]]: { theirs: USER_SERVER } };
    write(fileOf(name), JSON.stringify(before));
    expect(install(name).status).toBe('added');
    expect(readJson(fileOf(name))).toMatchObject({ theme: 'dark', [KEY[name]]: { theirs: USER_SERVER } });
    expect(uninstall(name).status).toBe('removed');
    expect(readJson(fileOf(name))).toEqual(before);
  });
});

describe('muse-code schema_version', () => {
  const written = { schema_version: 1, mcp_servers: { hippo: SERVER['muse-code'] } };

  it('seeds schema_version 1 in a missing file', () => {
    install('muse-code');
    expect(readJson(fileOf('muse-code'))).toEqual(written);
  });

  it.each([[''], ['  \n'], [BOM]])('seeds schema_version 1 in a blank file %j', (text) => {
    write(fileOf('muse-code'), text);
    expect(install('muse-code').status).toBe('added');
    expect(readJson(fileOf('muse-code'))).toEqual(written);
  });

  it('never adds schema_version to an existing object', () => {
    write(fileOf('muse-code'), '{"theme":"dark"}');
    install('muse-code');
    expect(readJson(fileOf('muse-code'))).toEqual({ theme: 'dark', mcp_servers: written.mcp_servers });
    write(fileOf('muse-code'), '{}');
    uninstall('muse-code');
    install('muse-code');
    expect(readJson(fileOf('muse-code'))).toEqual({ mcp_servers: written.mcp_servers });
  });

  it('keeps an existing schema_version value as it is', () => {
    write(fileOf('muse-code'), '{"schema_version":2}');
    install('muse-code');
    expect(readJson(fileOf('muse-code'))).toEqual({ schema_version: 2, mcp_servers: written.mcp_servers });
  });

  it('never removes schema_version on uninstall', () => {
    install('muse-code');
    uninstall('muse-code');
    expect(readJson(fileOf('muse-code'))).toEqual({ schema_version: 1 });
    write(fileOf('muse-code'), JSON.stringify({ mcp_servers: written.mcp_servers }));
    uninstall('muse-code');
    expect(readJson(fileOf('muse-code'))).toEqual({});
  });

  it('adds nothing when uninstall meets a blank file', () => {
    write(fileOf('muse-code'), '');
    expect(uninstall('muse-code').status).toBe('absent');
    expect(read(fileOf('muse-code'))).toBe('');
  });
});

describe('grok-build TOML', () => {
  const file = (): string => fileOf('grok-build');
  const seeded = (text: string): void => write(file(), text);

  it('appends to a missing file with no blank line before the table', () => {
    expect(install('grok-build')).toEqual({ name: 'grok-build', file: file(), status: 'added' });
    expect(read(file())).toBe(TABLE);
    expect(install('grok-build').status).toBe('present');
  });

  it('appends to an empty file with no blank line before the table', () => {
    seeded('');
    expect(install('grok-build').status).toBe('added');
    expect(read(file())).toBe(TABLE);
  });

  it('appends after a file with no trailing newline', () => {
    seeded('model = "x"');
    install('grok-build');
    expect(read(file())).toBe(`model = "x"\n\n${TABLE}`);
  });

  it('appends after a CRLF file in CRLF', () => {
    seeded('model = "x"\r\n');
    install('grok-build');
    expect(read(file())).toBe(`model = "x"\r\n\r\n${tableWith('\r\n')}`);
  });

  it('keeps the BOM of a BOM file', () => {
    seeded(`${BOM}model = "x"\n`);
    install('grok-build');
    expect(read(file())).toBe(`${BOM}model = "x"\n\n${TABLE}`);
    expect(fs.readFileSync(file()).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('puts the table right after the BOM of a BOM-only file', () => {
    seeded(BOM);
    install('grok-build');
    expect(read(file())).toBe(`${BOM}${TABLE}`);
  });

  it.each([
    ['LF', '\n', ''],
    ['CRLF', '\r\n', ''],
    ['BOM', '\n', BOM],
  ])('install then uninstall gives the original bytes: %s', (_label, eol, bom) => {
    const original = `${bom}model = "x"${eol}${eol}[other]${eol}a = 1${eol}`;
    seeded(original);
    expect(install('grok-build').status).toBe('added');
    expect(read(file())).toBe(`${original}${eol}${tableWith(eol)}`);
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe(original);
  });

  it('install then uninstall gives the original plus one newline when it had no final newline', () => {
    seeded('model = "x"');
    install('grok-build');
    uninstall('grok-build');
    expect(read(file())).toBe('model = "x"\n');
  });

  it('install then uninstall gives back an empty file and a BOM-only file', () => {
    for (const original of ['', BOM]) {
      seeded(original);
      install('grok-build');
      uninstall('grok-build');
      expect(read(file())).toBe(original);
    }
  });

  it('removes the table from the middle of a file and keeps the blank line after it', () => {
    seeded(`a = 1\n\n${TABLE}\n[other]\nb = 2\n`);
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe('a = 1\n\n[other]\nb = 2\n');
  });

  it('keeps a comment that sits inside the table when it removes it', () => {
    seeded(`[mcp_servers.hippo]\n# mine\ncommand = "hippo"\nargs = ["mcp"]\n`);
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe('# mine\n');
  });

  it('reports absent on uninstall for a missing file and a file with no table', () => {
    expect(uninstall('grok-build').status).toBe('absent');
    expect(fs.existsSync(file())).toBe(false);
    seeded('a = 1\n');
    expect(uninstall('grok-build').status).toBe('absent');
    expect(read(file())).toBe('a = 1\n');
  });

  const PRESENT: [string, string][] = [
    ['the plain table', TABLE],
    ['hippo.cmd', '[mcp_servers.hippo]\ncommand = "hippo.cmd"\nargs = ["mcp"]\n'],
    ['an indented table', '  [mcp_servers.hippo]\n\tcommand = "hippo"\n  args = ["mcp"]\n'],
    ['a quoted table key', '["mcp_servers".hippo]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['a single-quoted dotted header', '[\'mcp_servers\'.\'hippo\']\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['spaces around the dot', '[ mcp_servers . hippo ]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['a BOM first line', `${BOM}${TABLE}`],
    ['comments and blank lines in the body', '[mcp_servers.hippo]\n# note\ncommand = "hippo"\n\nargs = ["mcp"]\n'],
    ['CRLF line endings', tableWith('\r\n')],
    ['no final newline', TABLE.trimEnd()],
    ['another table after it', `${TABLE}\n[other]\na = 1\n`],
    ['other servers around it', `[mcp_servers.a]\ncommand = "x"\n\n${TABLE}\n[mcp_servers.b]\ncommand = "y"\n`],
  ];

  it.each(PRESENT)('present: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('present');
    seeded(text);
    expect(install('grok-build').status).toBe('present');
    expect(read(file())).toBe(text);
    expect(uninstall('grok-build').status).toBe('removed');
    expect(grokStatus(read(file()))).toBe('absent');
  });

  const USER_OWNED: [string, string][] = [
    ['another command', '[mcp_servers.hippo]\ncommand = "npx"\nargs = ["mcp"]\n'],
    ['other args', '[mcp_servers.hippo]\ncommand = "hippo"\nargs = ["mcp", "--x"]\n'],
    ['a missing args line', '[mcp_servers.hippo]\ncommand = "hippo"\n'],
    ['a sub-table next to the table', `${TABLE}\n[mcp_servers.hippo.env]\nA = "b"\n`],
    ['a sub-table alone', '[mcp_servers.hippo.env]\nA = "b"\n'],
    ['an array of tables', '[[mcp_servers.hippo]]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['two tables', `${TABLE}\n${TABLE}`],
    ['a root dotted key', 'mcp_servers.hippo.command = "hippo"\n'],
    ['a root dotted key before a table', 'mcp_servers.hippo = { command = "x" }\n\n[other]\na = 1\n'],
    ['a quoted root dotted key', '"mcp_servers"."hippo".command = "x"\n'],
    ['a root dotted key beside our table', `mcp_servers.hippo.command = "x"\n\n${TABLE}`],
    ['hippo under [mcp_servers]', '[mcp_servers]\nhippo = { command = "hippo", args = ["mcp"] }\n'],
    ['a dotted hippo key under [mcp_servers]', '[mcp_servers]\nhippo.command = "x"\n'],
    ['a quoted hippo key under [mcp_servers]', '[mcp_servers]\n"hippo" = { command = "x" }\n'],
    ['hippo under an indented [mcp_servers]', '  [mcp_servers]\n  hippo = { command = "x" }\n'],
    ['a root inline mcp_servers table', 'mcp_servers = { other = { command = "x" } }\n'],
  ];

  it.each(USER_OWNED)('user-owned: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('user-owned');
    seeded(text);
    expect(install('grok-build').status).toBe('user-owned');
    expect(uninstall('grok-build').status).toBe('user-owned');
    expect(read(file())).toBe(text);
  });

  const KEPT: [string, string][] = [
    ['hippo-memory with hippo and mcp', '[mcp_servers.hippo-memory]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['a quoted server name', '[mcp_servers."my memory"]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['npx with the package', '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "hippo-memory", "mcp"]\n'],
    [
      'npx with a pinned version',
      '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "hippo-memory@3.16.0", "mcp"]\n',
    ],
    [
      'a Windows path to hippo.cmd',
      '[mcp_servers.memory]\ncommand = "C:\\\\Users\\\\me\\\\hippo.cmd"\nargs = ["mcp"]\n',
    ],
    [
      'comments on the header and the key lines',
      '[mcp_servers.memory] # mine\ncommand = "hippo" # mine\nargs = ["mcp"] # mine\n',
    ],
    [
      'other servers around it',
      '[mcp_servers.a]\ncommand = "x"\n\n[mcp_servers.memory]\ncommand = "hippo"\nargs = ["mcp"]\n\n[mcp_servers.b]\ncommand = "y"\n',
    ],
    [
      'the hippo table with the npx form',
      '[mcp_servers.hippo]\ncommand = "npx"\nargs = ["-y", "hippo-memory", "mcp"]\n',
    ],
    ['an added startup_timeout_sec', `${TABLE}startup_timeout_sec = 60\n`],
    ['an added env', `${TABLE}env = { A = "b" }\n`],
    ['a trailing comment on a key line', `[mcp_servers.hippo]\ncommand = "hippo" # mine\nargs = ["mcp"]\n`],
    ['a trailing comment on the header', `[mcp_servers.hippo] # mine\ncommand = "hippo"\nargs = ["mcp"]\n`],
  ];

  it.each(KEPT)('kept: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('kept');
    seeded(text);
    expect(install('grok-build').status).toBe('kept');
    expect(uninstall('grok-build').status).toBe('kept');
    expect(read(file())).toBe(text);
  });

  const NOT_KEPT: [string, string][] = [
    ['hippo serve', '[mcp_servers.memory]\ncommand = "hippo"\nargs = ["serve"]\n'],
    ['hippo with mcp and more', '[mcp_servers.memory]\ncommand = "hippo"\nargs = ["mcp", "--x"]\n'],
    ['npx with another package', '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "other", "mcp"]\n'],
    ['a non-string args array', '[mcp_servers.memory]\ncommand = "hippo"\nargs = [1]\n'],
    ['single-quoted args', `[mcp_servers.memory]\ncommand = "hippo"\nargs = ['mcp']\n`],
    ['a multi-line args array', '[mcp_servers.memory]\ncommand = "hippo"\nargs = [\n  "mcp",\n]\n'],
    ['no args line', '[mcp_servers.memory]\ncommand = "hippo"\n'],
    ['two command lines', '[mcp_servers.memory]\ncommand = "hippo"\ncommand = "hippo"\nargs = ["mcp"]\n'],
    [
      'the keys in another table',
      '[mcp_servers.memory]\ncommand = "x"\n\n[other]\ncommand = "hippo"\nargs = ["mcp"]\n',
    ],
  ];

  it.each(NOT_KEPT)('not kept: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('absent');
    seeded(text);
    expect(uninstall('grok-build').status).toBe('absent');
    expect(read(file())).toBe(text);
    expect(install('grok-build').status).toBe('added');
    expect(grokStatus(read(file()))).toBe('present');
  });

  const ABSENT: [string, string][] = [
    ['an empty file', ''],
    ['unrelated keys', 'a = 1\n'],
    ['another server', '[mcp_servers.other]\ncommand = "x"\n'],
    ['a table named hippo2', '[mcp_servers.hippo2]\ncommand = "x"\n'],
    ['a commented-out table', '# [mcp_servers.hippo]\n'],
    ['hippo keys in another table', '[other]\nhippo = 1\nmcp_servers.hippo.command = "x"\n'],
    ['a hippo table under another parent', '[profiles.mcp_servers.hippo]\ncommand = "x"\n'],
    ['an [mcp_servers] table without hippo', '[mcp_servers]\nother = { command = "x" }\n'],
    ['dotted keys for another server', 'mcp_servers.other.command = "x"\n'],
  ];

  it.each(ABSENT)('absent: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('absent');
    seeded(text);
    expect(uninstall('grok-build').status).toBe('absent');
    expect(read(file())).toBe(text);
    expect(install('grok-build').status).toBe('added');
    expect(grokStatus(read(file()))).toBe('present');
  });
});

describe('a filesystem error on one host file', () => {
  it.each(['junie', 'grok-build'])('on %s leaves the other hosts installed', (broken) => {
    fs.mkdirSync(fileOf(broken), { recursive: true });
    const results = MCP_CONFIG_HOSTS.map((row) => installMcpConfigHost(row, homes));
    for (const result of results) {
      if (result.name === broken) {
        expect(isMcpFailure(result.status)).toBe(true);
        continue;
      }
      expect(result.status).toBe('added');
      expect(fs.statSync(result.file).isFile()).toBe(true);
    }
    expect(fs.statSync(fileOf(broken)).isDirectory()).toBe(true);
  });

  it.each(['junie', 'grok-build'])('on %s is reported by uninstall too', (broken) => {
    fs.mkdirSync(fileOf(broken), { recursive: true });
    const results = MCP_CONFIG_HOSTS.map((row) => uninstallMcpConfigHost(row, homes));
    expect(results.filter((result) => isMcpFailure(result.status)).map((result) => result.name)).toEqual([broken]);
  });
});
