// A Windows npm launcher as npm writes it: a .ps1 beside `node_modules/<name>/bin/<name>.js`, the script it runs.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Writes `<dir>/<name>.ps1` over a script holding `jsSource` and answers the .ps1 path. */
export function writeNpmPs1Shim(dir: string, name: string, jsSource: string): string {
  const entryDir = path.join(dir, 'node_modules', name, 'bin');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, `${name}.js`), jsSource, 'utf8');
  const shim = path.join(dir, `${name}.ps1`);
  const script = `"$basedir/node_modules/${name}/bin/${name}.js"`;
  fs.writeFileSync(
    shim,
    [
      '#!/usr/bin/env pwsh',
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
      `& "node$exe" ${script} $args`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n'),
    'utf8',
  );
  return shim;
}
