// Preloaded into a spawned CLI: appends each child_process.spawn argv to RECORD_SPAWN_FILE before the child starts, so the file is final once the CLI exits.
const fs = require('node:fs');
const childProcess = require('node:child_process');

const realSpawn = childProcess.spawn;
childProcess.spawn = function recordingSpawn(...args) {
  if (process.env.RECORD_SPAWN_FILE) fs.appendFileSync(process.env.RECORD_SPAWN_FILE, `${JSON.stringify(args[1])}\n`);
  return realSpawn.apply(this, args);
};
// The CLI is ESM; without this its named `spawn` import keeps the unpatched function.
require('node:module').syncBuiltinESMExports();
