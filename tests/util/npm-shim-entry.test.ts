// An npm .ps1 shim names the script it runs; codex-run starts that script with Node instead of PowerShell.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { npmShimEntry } from '../../src/host/spawn-argv.js';
import { makeRoot } from '../_helpers/make-root.js';

let dir: string;

beforeEach(() => {
  dir = makeRoot('npm-shim-entry');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function shim(body: string): string {
  const file = path.join(dir, 'codex.ps1');
  fs.writeFileSync(file, body);
  return file;
}

describe('npmShimEntry', () => {
  it('answers the script an npm shim runs, with either slash', () => {
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '');
    expect(npmShimEntry(shim('& "node$exe" "$basedir/node_modules/@openai/codex/bin/codex.js" $args'))).toBe(script);
    const backslashed = ['$basedir', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'].join(
      String.fromCharCode(92),
    );
    expect(npmShimEntry(shim(`& node "${backslashed}" $args`))).toBe(script);
  });

  it('answers null for a shim with no script, a script that is missing, or one that climbs out of the folder', () => {
    expect(npmShimEntry(shim('& powershell -File evil.ps1'))).toBeNull();
    expect(npmShimEntry(shim('& node "$basedir/node_modules/gone/bin/gone.js" $args'))).toBeNull();
    fs.writeFileSync(path.join(path.dirname(dir), 'outside.js'), '');
    expect(npmShimEntry(shim('& node "$basedir/node_modules/../../outside.js" $args'))).toBeNull();
    fs.rmSync(path.join(path.dirname(dir), 'outside.js'), { force: true });
  });

  it('answers null for a shim it cannot read', () => {
    expect(npmShimEntry(path.join(dir, 'missing.ps1'))).toBeNull();
  });
});
