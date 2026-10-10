#!/usr/bin/env node
// Toy checker for the regrade tests: dumps its whole env to $Z0_ENV_DUMP_DIR/<n>.json, so a test can compare the run's checker env with the regrade's.
// Args: exit=<n> (default 0).
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.env.Z0_ENV_DUMP_DIR;
if (dir) {
  fs.mkdirSync(dir, { recursive: true });
  const n = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length + 1;
  fs.writeFileSync(path.join(dir, `${String(n).padStart(3, '0')}.json`), JSON.stringify(process.env));
}
const exit = process.argv.slice(2).find((a) => a.startsWith('exit='));
process.exit(exit ? Number(exit.slice('exit='.length)) : 0);
