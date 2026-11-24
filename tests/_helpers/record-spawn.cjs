const fs = require('node:fs');
const childProcess = require('node:child_process');

const realSpawn = childProcess.spawn;
childProcess.spawn = function recordingSpawn(...args) {
  if (process.env.RECORD_SPAWN_FILE) fs.appendFileSync(process.env.RECORD_SPAWN_FILE, `${JSON.stringify(args[1])}\n`);
  return realSpawn.apply(this, args);
};
require('node:module').syncBuiltinESMExports();
