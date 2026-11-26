import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Homes } from '../../src/base/util/agent-homes.js';
import { log } from '../../src/base/util/log.js';
import { parseJson, type JsonObject, type JsonValue } from '../../src/base/util/json.js';
import {
  installMcpConfigHost,
  isMcpConfigHostPresent,
  uninstallMcpConfigHost,
} from '../../src/surface/hooks-install/mcp-config.js';
import { grokStatus, planGrokInstall } from '../../src/surface/hooks-install/rules/grok-build.js';
import {
  isMcpFailure,
  isMcpMaybeHippo,
  MCP_CONFIG_HOSTS,
  npxMentionsHippo,
  runsHippoMcp,
  type McpConfigRow,
} from '../../src/surface/hooks-install/rules/mcp-config.js';
import { mcpInstallLines, mcpRemoveLines } from '../../src/surface/cli/mcp-config-report.js';

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
const BASE = {
  junie: {},
  antigravity: {},
  'muse-code': { schema_version: 1 },
} as const satisfies Record<string, JsonObject>;
const USER_SERVER = { command: 'npx', args: ['their-server'] };
const TABLE = `[mcp_servers.hippo]\ncommand = "${CMD}"\nargs = ["mcp"]\n`;
const tableWith = (eol: string): string => TABLE.replace(/\n/g, eol);
const HAND_WRITTEN: [string, JsonObject][] = [
  ['hippo with mcp', { command: 'hippo', args: ['mcp'] }],
  ['a Windows path to hippo.cmd', { command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\hippo.cmd', args: ['mcp'] }],
];
const MAYBE_HIPPO_NPX_ARGS: [string, string[]][] = [
  ['npx -y hippo-memory mcp', ['-y', 'hippo-memory', 'mcp']],
  ['npx with a pinned version', ['-y', 'hippo-memory@3.16.0', 'mcp']],
  ['npx --versions hippo-memory mcp', ['--versions', 'hippo-memory', 'mcp']],
  ['npx --browser --loglevel silent', ['--browser', '--loglevel', 'silent', 'hippo-memory', 'mcp']],
  ['npx -p hippo-memory@3.16.0', ['-p', 'hippo-memory@3.16.0', 'hippo', 'mcp']],
  ['npx -y other-cli hippo-memory mcp', ['-y', 'other-cli', 'hippo-memory', 'mcp']],
];
const MAYBE_HIPPO_NPX: [string, JsonObject][] = MAYBE_HIPPO_NPX_ARGS.map(([label, args]) => [
  label,
  { command: 'npx', args },
]);
const NOT_HIPPO_MCP: [string, JsonObject][] = [
  ['hippo serve', { command: 'hippo', args: ['serve'] }],
  ['hippo recall', { command: 'hippo', args: ['recall'] }],
  ['npx with another package', { command: 'npx', args: ['-y', 'other-memory', 'mcp'] }],
  ['npx with a hyphenated sibling name', { command: 'npx', args: ['-y', 'my-hippo-memory-helper', 'mcp'] }],
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
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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

function expectMaybeHippo(host: string, key: string, text: string, tableKey?: string): void {
  write(fileOf(host), text);
  const added = install(host);
  const removed = uninstall(host);
  const row = rowNamed(host);
  const expected =
    row.format.kind === 'json' ? { maybeHippo: key, tableKey: tableKey ?? row.format.host.key } : { maybeHippo: key };
  const head = `A server named ${JSON.stringify(key)} in ${added.file} may already run hippo; the file is left as it is`;
  const replace =
    row.format.kind === 'json'
      ? 'replace the entry with this '
      : 'update the "hippo" server under mcp_servers in place ';
  const verb = key === 'hippo' ? replace : 'add ';
  expect([added.status, removed.status, isMcpMaybeHippo(added.status), isMcpFailure(added.status)]).toEqual([
    expected,
    expected,
    true,
    false,
  ]);
  expect(mcpInstallLines(added.file, added.status, row, 'none')).toEqual([head]);
  expect(mcpInstallLines(added.file, added.status, row, 'hint')).toEqual([
    `${head}; if it does not, run \`hippo hook install ${host}\` to see the entry to paste`,
  ]);
  const snippet = mcpInstallLines(added.file, added.status, row, 'snippet');
  expect(snippet[0]).toContain(`${head}; if it does not, ${verb}`);
  if (tableKey !== undefined) expect(snippet[0]).toContain(`under "${tableKey}"`);
  expect(mcpRemoveLines(removed.file, removed.status, row)).toEqual([
    `Left ${JSON.stringify(key)} in ${removed.file}: it may run hippo via npx; ` +
      'check whether it starts hippo before removing it by hand',
  ]);
  expect(read(fileOf(host))).toBe(text);
}

function failStat(failure: Error, target: string): void {
  const real = fs.statSync;
  // SAFETY: the stand-in forwards every call it does not fail to the real statSync with the caller's own arguments.
  const stand = ((p: fs.PathLike, ...rest: [fs.StatSyncOptions?]) => {
    if (String(p) === target) throw failure;
    return real(p, ...rest);
  }) as typeof fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(stand);
  syncBuiltinESMExports();
}

describe('the host rows', () => {
  it('name the four hosts and the files hippo edits', () => {
    expect(MCP_CONFIG_HOSTS.map((row) => row.name)).toEqual(['junie', 'antigravity', 'grok-build', 'muse-code']);
    expect(fileOf('junie')).toBe(path.join(home, '.junie', 'mcp', 'mcp.json'));
    expect(fileOf('antigravity')).toBe(path.join(home, '.gemini', 'config', 'mcp_config.json'));
    expect(fileOf('grok-build')).toBe(path.join(home, '.grok', 'config.toml'));
    expect(fileOf('muse-code')).toBe(path.join(home, '.config', 'muse', 'settings.json'));
  });

  it('read HOME and XDG_CONFIG_HOME before default paths', () => {
    const elsewhere: Homes = { home: path.join(home, 'profile'), env: { HOME: home } };
    expect(rowNamed('junie').file(elsewhere)).toBe(fileOf('junie'));
    const xdg = path.join(home, 'xdg');
    const withXdg: Homes = { home, env: { XDG_CONFIG_HOME: xdg } };
    expect(rowNamed('muse-code').file(withXdg)).toBe(path.join(xdg, 'muse', 'settings.json'));
    expect(rowNamed('muse-code').dirs(withXdg)).toEqual([path.join(xdg, 'muse')]);
  });

  it('count a host as present only when one of its folders exists, not a file', () => {
    for (const row of MCP_CONFIG_HOSTS) expect(isMcpConfigHostPresent(row, homes)).toBe(false);
    write(path.join(home, '.junie'), 'not a folder');
    expect(isMcpConfigHostPresent(rowNamed('junie'), homes)).toBe(false);
    fs.rmSync(path.join(home, '.junie'));
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

  it('honor GROK_HOME when set and non-blank, checking and writing only there', () => {
    const grok = path.join(home, 'grok-elsewhere');
    const withGrok: Homes = { home, env: { GROK_HOME: grok } };
    expect(rowNamed('grok-build').file(withGrok)).toBe(path.join(grok, 'config.toml'));
    expect(rowNamed('grok-build').dirs(withGrok)).toEqual([grok]);
    for (const blank of ['', '  ']) {
      const blankHome: Homes = { home, env: { GROK_HOME: blank } };
      expect(rowNamed('grok-build').file(blankHome)).toBe(fileOf('grok-build'));
      expect(rowNamed('grok-build').dirs(blankHome)).toEqual([path.join(home, '.grok')]);
    }
    fs.mkdirSync(path.join(home, '.grok'));
    expect(isMcpConfigHostPresent(rowNamed('grok-build'), withGrok)).toBe(false);
    fs.mkdirSync(grok);
    expect(isMcpConfigHostPresent(rowNamed('grok-build'), withGrok)).toBe(true);
    expect(installMcpConfigHost(rowNamed('grok-build'), withGrok).status).toBe('added');
    expect([read(path.join(grok, 'config.toml')), fs.existsSync(fileOf('grok-build'))]).toEqual([TABLE, false]);
  });

  it('warn about a folder whose check fails, count it as absent and still check the other folders', () => {
    const [first, second] = rowNamed('antigravity').dirs(homes);
    fs.mkdirSync(second, { recursive: true });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const failure = Object.assign(new Error(`ENOTDIR: not a directory, stat '${first}'`), {
      code: 'ENOTDIR',
      syscall: 'stat',
    });
    failStat(failure, first);
    expect(isMcpConfigHostPresent(rowNamed('antigravity'), homes)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(first), expect.anything());
    fs.rmSync(second, { recursive: true });
    expect(isMcpConfigHostPresent(rowNamed('antigravity'), homes)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('throw a folder check failure that is not a filesystem error', () => {
    failStat(new TypeError('bad argument'), rowNamed('junie').dirs(homes)[0]);
    expect(() => isMcpConfigHostPresent(rowNamed('junie'), homes)).toThrow('bad argument');
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

  it.each(MAYBE_HIPPO_NPX)(
    'warns and leaves an npx entry (%s) unchanged on install and uninstall under hippo-memory and hippo',
    (_label, server) => {
      for (const key of ['hippo-memory', 'hippo']) {
        expectMaybeHippo(name, key, JSON.stringify({ [KEY[name]]: { [key]: server } }));
      }
    },
  );

  it('prefers kept over maybeHippo when both exist', () => {
    const text = JSON.stringify({
      [KEY[name]]: {
        npxOne: { command: 'npx', args: ['-y', 'hippo-memory', 'mcp'] },
        exactOne: { command: 'hippo', args: ['mcp'] },
      },
    });
    write(fileOf(name), text);
    expect([install(name).status, uninstall(name).status, read(fileOf(name))]).toEqual(['kept', 'kept', text]);
  });

  it.each(NOT_HIPPO_MCP)('does not count a "hippo-memory" entry running %s: install adds "hippo"', (_label, server) => {
    const before = { ...BASE[name], [KEY[name]]: { 'hippo-memory': server } };
    write(fileOf(name), JSON.stringify(before));
    expect(uninstall(name).status).toBe('absent');
    expect(install(name).status).toBe('added');
    expect(readJson(fileOf(name))).toMatchObject({ [KEY[name]]: { 'hippo-memory': server, hippo: SERVER[name] } });
    expect(uninstall(name).status).toBe('removed');
    expect(readJson(fileOf(name))).toEqual(before);
    expect(uninstall(name).status).toBe('absent');
  });

  it.each(FILE_STYLES)('keeps the file style on install and uninstall: %s', (_label, bom, eol, indent, end) => {
    const dress = (value: JsonObject): string => bom + JSON.stringify(value, null, indent).replace(/\n/g, eol) + end;
    const original = dress({ ...BASE[name], theme: 'dark', [KEY[name]]: { theirs: USER_SERVER } });
    write(fileOf(name), original);
    expect(install(name).status).toBe('added');
    expect(read(fileOf(name))).toBe(
      dress({ ...BASE[name], theme: 'dark', [KEY[name]]: { theirs: USER_SERVER, hippo: SERVER[name] } }),
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
    const before = { ...BASE[name], theme: 'dark', [KEY[name]]: { theirs: USER_SERVER } };
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

  it.each([['{}'], ['{"theme":"x"}'], ['{"mcp_servers":{"theirs":{"command":"x","args":[]}}}']])(
    'leaves an existing file with no schema_version unchanged: invalid for %s',
    (text) => {
      write(fileOf('muse-code'), text);
      expect(install('muse-code')).toEqual({ name: 'muse-code', file: fileOf('muse-code'), status: 'invalid' });
      expect(uninstall('muse-code').status).toBe('absent');
      expect(read(fileOf('muse-code'))).toBe(text);
    },
  );

  it.each([[true], [false]])(
    'keeps a hand-written entry with no mode, which Muse reads as required: kept, no byte changed (schema_version %s)',
    (withSchema) => {
      const entry = { transport: 'stdio', command: 'hippo', args: ['mcp'] };
      const servers = { hippo: entry };
      const text = JSON.stringify(withSchema ? { schema_version: 1, mcp_servers: servers } : { mcp_servers: servers });
      write(fileOf('muse-code'), text);
      expect(install('muse-code').status).toBe('kept');
      expect(uninstall('muse-code').status).toBe('kept');
      expect(read(fileOf('muse-code'))).toBe(text);
    },
  );

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
    expect([uninstall('muse-code').status, read(fileOf('muse-code'))]).toEqual(['absent', '']);
  });

  it('reuses legacy mcpServers and reports conflicting-keys when both spellings exist', () => {
    const legacy = { schema_version: 1, mcpServers: { theirs: USER_SERVER } };
    write(fileOf('muse-code'), JSON.stringify(legacy));
    expect(install('muse-code').status).toBe('added');
    expect(readJson(fileOf('muse-code'))).toEqual({
      schema_version: 1,
      mcpServers: { theirs: USER_SERVER, hippo: SERVER['muse-code'] },
    });
    expect([uninstall('muse-code').status, readJson(fileOf('muse-code'))]).toEqual(['removed', legacy]);
    expectMaybeHippo(
      'muse-code',
      'mem',
      JSON.stringify({
        schema_version: 1,
        mcpServers: { mem: { command: 'npx', args: ['-y', 'hippo-memory', 'mcp'] } },
      }),
      'mcpServers',
    );
    const both = JSON.stringify({ schema_version: 1, mcp_servers: {}, mcpServers: {} });
    write(fileOf('muse-code'), both);
    const row = rowNamed('muse-code');
    expect([install('muse-code').status, uninstall('muse-code').status, read(fileOf('muse-code'))]).toEqual([
      'conflicting-keys',
      'conflicting-keys',
      both,
    ]);
    expect(mcpInstallLines(fileOf('muse-code'), 'conflicting-keys', row, 'snippet')[0]).toContain(
      '"mcp_servers" and "mcpServers"',
    );
    expect(mcpRemoveLines(fileOf('muse-code'), 'conflicting-keys', row)[0]).toContain('"mcp_servers" and "mcpServers"');
  });
});

describe('grok-build TOML', () => {
  const file = (): string => fileOf('grok-build');
  const seeded = (text: string): void => write(file(), text);

  it.each([
    ['missing', null, TABLE],
    ['empty', '', TABLE],
    ['no trailing newline', 'model = "x"', `model = "x"\n\n${TABLE}`],
    ['CRLF', 'model = "x"\r\n', `model = "x"\r\n\r\n${tableWith('\r\n')}`],
    ['BOM', `${BOM}model = "x"\n`, `${BOM}model = "x"\n\n${TABLE}`],
    ['BOM-only', BOM, `${BOM}${TABLE}`],
  ])('appends cleanly to a %s file', (_label, initial, expected) => {
    if (initial !== null) seeded(initial);
    expect(install('grok-build')).toEqual({ name: 'grok-build', file: file(), status: 'added' });
    expect([read(file()), install('grok-build').status]).toEqual([expected, 'present']);
    if (initial?.startsWith(BOM)) {
      expect(fs.readFileSync(file()).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    }
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

  it('present: keeps a comment that sits inside a CRLF table when it removes it', () => {
    const text = '[mcp_servers.hippo]\r\n# mine\r\ncommand = "hippo"\r\nargs = ["mcp"]\r\n';
    expect(grokStatus(text)).toBe('present');
    seeded(text);
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe('# mine\r\n');
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
    ['indented key lines and trailing spaces', '[mcp_servers.hippo]  \n\tcommand = "hippo"\n  args = ["mcp"]  \n'],
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

  const STRING_HOLDS_TABLE: [string, string][] = [
    ['a multiline basic string', '"""'],
    ['a multiline literal string', "'''"],
  ];

  it.each(STRING_HOLDS_TABLE)('absent: %s holds a hippo table and ends on a [x] line', (_label, quote) => {
    const text = `note = ${quote}\n${TABLE}[x]${quote}\nmodel = "x"\n`;
    expect(grokStatus(text)).toBe('absent');
    seeded(text);
    expect(uninstall('grok-build').status).toBe('absent');
    expect(read(file())).toBe(text);
    expect(install('grok-build').status).toBe('added');
    expect(read(file())).toBe(`${text}\n${TABLE}`);
    expect(grokStatus(read(file()))).toBe('present');
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe(text);
  });

  it.each(STRING_HOLDS_TABLE)('kept, not present: a hippo table whose body holds %s', (_label, quote) => {
    const text = `${TABLE}note = ${quote}\nmore\n${quote}\n`;
    expect(grokStatus(text)).toBe('kept');
    seeded(text);
    expect(uninstall('grok-build').status).toBe('kept');
    expect(read(file())).toBe(text);
  });

  const UNREADABLE: [string, string][] = [
    ['a """ string open at the end of the file', `model = "x"\nnote = """\n${TABLE}`],
    ['a "\\q" key', '"\\q" = 1\n'],
    ['an inline mcp_servers table, which a [mcp_servers.hippo] header cannot extend', 'mcp_servers = { a = {} }\n'],
    ['an mcp_servers array of tables', '[[mcp_servers]]\nname = "x"\n'],
    ['a root inline mcp_servers table with another server', 'mcp_servers = { other = { command = "x" } }\n'],
  ];

  it.each(UNREADABLE)('unreadable: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('unreadable');
    expect(planGrokInstall(text, CMD)).toBe(text);
    seeded(text);
    const result = install('grok-build');
    expect(result.status).toBe('unreadable');
    const lines = mcpInstallLines(result.file, result.status, rowNamed('grok-build'), 'snippet');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('if it has no hippo server, add a "hippo" server under mcp_servers by hand');
    expect(lines[0]).not.toContain('[mcp_servers.hippo]');
    expect(uninstall('grok-build').status).toBe('unreadable');
    expect(read(file())).toBe(text);
  });

  const USER_OWNED: [string, string][] = [
    ['keys inside a multiline string', '[mcp_servers.hippo]\nnote = """\ncommand = "hippo"\nargs = ["mcp"]\n"""\n'],
    ['another command', '[mcp_servers.hippo]\ncommand = "npx"\nargs = ["mcp"]\n'],
    ['other args', '[mcp_servers.hippo]\ncommand = "hippo"\nargs = ["mcp", "--x"]\n'],
    ['a missing args line', '[mcp_servers.hippo]\ncommand = "hippo"\n'],
    [
      'another command and a sub-table',
      '[mcp_servers.hippo]\ncommand = "other"\nargs = ["mcp"]\n\n[mcp_servers.hippo.env]\nA = "b"\n',
    ],
    ['an escaped hippo key with another command', '[mcp_servers."\\u0068ippo"]\ncommand = "other"\nargs = ["mcp"]\n'],
    ['an escaped dotted key', 'mcp_servers."\\u0068ippo".command = "x"\n'],
    ['a sub-table alone', '[mcp_servers.hippo.env]\nA = "b"\n'],
    ['an array of tables', '[[mcp_servers.hippo]]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['two tables', `${TABLE}\n${TABLE}`],
    ['a root dotted key', 'mcp_servers.hippo.command = "hippo"\n'],
    ['a root dotted key with another command', 'mcp_servers.hippo.command = "other"\n'],
    ['a root dotted key before a table', 'mcp_servers.hippo = { command = "x" }\n\n[other]\na = 1\n'],
    ['a quoted root dotted key', '"mcp_servers"."hippo".command = "x"\n'],
    ['a root dotted key beside our table', `mcp_servers.hippo.command = "x"\n\n${TABLE}`],
    ['a dotted hippo key under [mcp_servers]', '[mcp_servers]\nhippo.command = "x"\n'],
    ['a quoted hippo key under [mcp_servers]', '[mcp_servers]\n"hippo" = { command = "x" }\n'],
    ['hippo under an indented [mcp_servers]', '  [mcp_servers]\n  hippo = { command = "x" }\n'],
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
    ['an added startup_timeout_sec', `${TABLE}startup_timeout_sec = 60\n`],
    ['an added env', `${TABLE}env = { A = "b" }\n`],
    ['a trailing comment on a key line', `[mcp_servers.hippo]\ncommand = "hippo" # mine\nargs = ["mcp"]\n`],
    ['a trailing comment on the header', `[mcp_servers.hippo] # mine\ncommand = "hippo"\nargs = ["mcp"]\n`],
    ['an indented header', '  [mcp_servers.hippo]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['a quoted table key', '["mcp_servers".hippo]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['a single-quoted dotted header', '[\'mcp_servers\'.\'hippo\']\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['spaces around the dot', '[ mcp_servers . hippo ]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['an escaped hippo key', '[mcp_servers."\\u0068ippo"]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ['an escaped parent key', '["mcp_\\u0073ervers".hippo]\ncommand = "hippo"\nargs = ["mcp"]\n'],
    ["hippo's own lines and a sub-table", `${TABLE}\n[mcp_servers.hippo.env]\nA = "b"\n`],
    ['hippo under [mcp_servers]', '[mcp_servers]\nhippo = { command = "hippo", args = ["mcp"] }\n'],
    ['hippo in a root inline table', 'mcp_servers = { hippo = { command = "hippo", args = ["mcp"] } }\n'],
    ['another server in an inline table', '[mcp_servers]\nmem = { command = "hippo", args = ["mcp"] }\n'],
    ['single-quoted args', `[mcp_servers.memory]\ncommand = "hippo"\nargs = ['mcp']\n`],
  ];

  it.each(KEPT)('kept: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('kept');
    seeded(text);
    expect(install('grok-build').status).toBe('kept');
    expect(uninstall('grok-build').status).toBe('kept');
    expect(read(file())).toBe(text);
  });

  const MAYBE_HIPPO: [string, string, string][] = [
    ...MAYBE_HIPPO_NPX.map(([label, server]): [string, string, string] => [
      label,
      'memory',
      `[mcp_servers.memory]\ncommand = "npx"\nargs = ${JSON.stringify(server.args)}\n`,
    ]),
    [
      'the hippo table with npx',
      'hippo',
      '[mcp_servers.hippo]\ncommand = "npx"\nargs = ["-y", "hippo-memory", "mcp"]\n',
    ],
    [
      'a multi-line npx args array',
      'mem',
      '[mcp_servers.mem]\ncommand = "npx"\nargs = [\n  "-y",\n  "hippo-memory",\n  "mcp",\n]\n',
    ],
  ];

  it.each(MAYBE_HIPPO)('maybeHippo: %s', (_label, key, text) => {
    expect(grokStatus(text)).toEqual({ maybeHippo: key });
    expect(planGrokInstall(text, CMD)).toBe(text);
    expectMaybeHippo('grok-build', key, text);
  });

  it('prefers kept over maybeHippo when both exist', () => {
    const text =
      '[mcp_servers.a]\ncommand = "npx"\nargs = ["-y", "hippo-memory", "mcp"]\n\n[mcp_servers.b]\ncommand = "hippo"\nargs = ["mcp"]\n';
    expect(grokStatus(text)).toBe('kept');
    seeded(text);
    expect([install('grok-build').status, uninstall('grok-build').status, read(file())]).toEqual([
      'kept',
      'kept',
      text,
    ]);
  });

  const NOT_KEPT: [string, string][] = [
    ['hippo serve', '[mcp_servers.memory]\ncommand = "hippo"\nargs = ["serve"]\n'],
    ['hippo with mcp and more', '[mcp_servers.memory]\ncommand = "hippo"\nargs = ["mcp", "--x"]\n'],
    ['npx with another package', '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "other-memory", "mcp"]\n'],
    ['npx with playwright', '[mcp_servers.memory]\ncommand = "npx"\nargs = ["@playwright/mcp@latest"]\n'],
    ['a non-string args array', '[mcp_servers.memory]\ncommand = "hippo"\nargs = [1]\n'],
    ['no args line', '[mcp_servers.memory]\ncommand = "hippo"\n'],
    ['an array of server tables', '[[mcp_servers.memory]]\ncommand = "hippo"\nargs = ["mcp"]\n'],
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
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe(text);
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
    ['a backslash in a comment', 'a = 1\n# C:\\x = y\n'],
    ['escapes in a multiline string', 'a = """\n[b\\u0068]\nc\\\\d = 1\n"""\n'],
    ['a backslash in a multiline literal string', "a = '''\n[b\\u0068]\nc\\d = 1\n'''\n"],
    ['a header with a Windows path in its comment', '[projects] # C:\\Users\ntheme = "dark"\n'],
    ['a literal key with a backslash', "[projects.'C:\\repo']\ntrusted = true\n"],
    [
      'Windows paths in values',
      "[mcp_servers.fs]\ncommand = \"C:\\\\tools\\\\fs.exe\"\nargs = [\n  'C:\\a', 'b=c',\n]\n",
    ],
    ['a nested array with [1, 2], lines', 'matrix = [\n  [1, 2],\n  [3, 4],\n]\n'],
    [
      'a multi-line string holding a hippo table and ending on a [x] line',
      'note = """\n[mcp_servers.hippo]\ncommand = "hippo"\n[x]"""\n',
    ],
  ];

  it.each(ABSENT)('absent: %s', (_label, text) => {
    expect(grokStatus(text)).toBe('absent');
    seeded(text);
    expect(uninstall('grok-build').status).toBe('absent');
    expect(read(file())).toBe(text);
    expect(install('grok-build').status).toBe('added');
    expect(grokStatus(read(file()))).toBe('present');
    expect(uninstall('grok-build').status).toBe('removed');
    expect(read(file())).toBe(text);
  });
});

describe('runsHippoMcp and npxMentionsHippo', () => {
  const npxArgLists = [
    ...MAYBE_HIPPO_NPX_ARGS.map(([, args]) => args),
    ['hippo-memory', 'mcp'],
    ['--package=hippo-memory@3.16.0', 'hippo', 'mcp'],
  ];

  it('matches exact hippo mcp only and detects npx mentions without flag parsing', () => {
    const hippos = [
      'hippo',
      'hippo.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\hippo.cmd',
      '/usr/local/bin/hippo',
      'HIPPO.EXE',
    ];
    for (const cmd of hippos) expect(runsHippoMcp(cmd, ['mcp'])).toBe(true);
    for (const args of [['serve'], ['mcp', '--x'], []]) expect(runsHippoMcp('hippo', args)).toBe(false);
    for (const cmd of ['npx', 'npx.cmd', '/usr/local/bin/npx']) {
      for (const args of npxArgLists) {
        expect([runsHippoMcp(cmd, args), npxMentionsHippo(cmd, args)]).toEqual([false, true]);
      }
    }
    for (const args of [['-y', 'other-memory', 'mcp'], ['-y', 'my-hippo-memory-helper', 'mcp'], []]) {
      expect(npxMentionsHippo('npx', args)).toBe(false);
    }
    for (const cmd of ['hippo', 'node']) expect(npxMentionsHippo(cmd, ['hippo-memory', 'mcp'])).toBe(false);
    const vals = [{ failed: 'EACCES' }, { maybeHippo: 'hippo' }, 'kept'] as const;
    expect(vals.map(isMcpFailure)).toEqual([true, false, false]);
    expect(vals.map(isMcpMaybeHippo)).toEqual([false, true, false]);
  });
});

describe('a filesystem error on one host file', () => {
  it.each(['junie', 'grok-build'])('on %s leaves other hosts installed and reports uninstall failure', (broken) => {
    fs.mkdirSync(fileOf(broken), { recursive: true });
    const added = MCP_CONFIG_HOSTS.map((row) => installMcpConfigHost(row, homes));
    expect(added.filter((r) => isMcpFailure(r.status)).map((r) => r.name)).toEqual([broken]);
    for (const r of added.filter((r) => r.name !== broken)) {
      expect([r.status, fs.statSync(r.file).isFile()]).toEqual(['added', true]);
    }
    const removed = MCP_CONFIG_HOSTS.map((row) => uninstallMcpConfigHost(row, homes));
    expect(removed.filter((r) => isMcpFailure(r.status)).map((r) => r.name)).toEqual([broken]);
    expect(fs.statSync(fileOf(broken)).isDirectory()).toBe(true);
  });
});
