// Preloaded into a spawned CLI: appends each child_process.spawn argv and pid to RECORD_SPAWN_FILE as one JSON line, so the file is final once the CLI exits.
const fs = require('node:fs');
const childProcess = require('node:child_process');

const realSpawn = childProcess.spawn;
childProcess.spawn = function recordingSpawn(...args) {
  const child = realSpawn.apply(this, args);
  if (process.env.RECORD_SPAWN_FILE) {
    fs.appendFileSync(process.env.RECORD_SPAWN_FILE, `${JSON.stringify({ argv: args[1], pid: child.pid ?? null })}\n`);
  }
  return child;
};
// The CLI is ESM; without this its named `spawn` import keeps the unpatched function.
require('node:module').syncBuiltinESMExports();
