// The plugin ships its own copy of hippo's PATH lookup and cmd.exe quoting; both must answer each case the same way.
import { describe, expect, it } from 'vitest';
import { splitPathList } from '../../src/base/util/env.js';
import { cmdShimArgs } from '../../src/host/spawn-argv.js';
import * as plugin from '../../extensions/claude-code-plugin/scripts/spawn-hippo.mjs';

const PATH_CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['C:\\a;C:\\b', ['C:\\a', 'C:\\b']],
  ['"C:\\Program Files\\nodejs";C:\\y', ['C:\\Program Files\\nodejs', 'C:\\y']],
  ['"C:\\a;b";C:\\c', ['C:\\a;b', 'C:\\c']],
  ['C:\\a"b"c', ['C:\\abc']],
  [';;C:\\a;', ['C:\\a']],
  ['', []],
];

const SHIM_CASES: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ['C:\\npm\\hippo.cmd', ['context', '--pinned-only'], '""C:\\npm\\hippo.cmd" context --pinned-only"'],
  ['C:\\x %USERNAME%\\hippo.cmd', ['a b'], '""C:\\x "^%"USERNAME"^%"\\hippo.cmd" "a b""'],
  ['C:\\a,b\\hippo.cmd', [], '""C:\\a,b\\hippo.cmd""'],
];

describe('win32 PATH folders', () => {
  it.each(PATH_CASES)('reads %j as cmd.exe does, in hippo and in the plugin', (value, dirs) => {
    expect(splitPathList(value, 'win32')).toEqual(dirs);
    expect(plugin.windowsPathDirs(value)).toEqual(dirs);
  });

  it('splits on a colon and keeps quotes off win32', () => {
    expect(splitPathList('/a:"/b"::', 'linux')).toEqual(['/a', '"/b"']);
  });
});

describe('cmd.exe line for a shim', () => {
  it.each(SHIM_CASES)('quotes %j and its arguments the same in hippo and the plugin', (file, args, line) => {
    const expected = ['/d', '/v:off', '/s', '/c', line];
    expect(cmdShimArgs(file, args)).toEqual(expected);
    expect(plugin.cmdShimArgs(file, args)).toEqual(expected);
  });
});
