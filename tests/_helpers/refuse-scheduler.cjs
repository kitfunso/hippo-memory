// Preloaded into a spawned CLI: logs each schtasks or crontab call to SCHEDULER_CALLS_FILE and throws instead of running it.
const fs = require('node:fs');
const childProcess = require('node:child_process');

const record = (line) => fs.appendFileSync(process.env.SCHEDULER_CALLS_FILE, `${line}\n`);
record('preload');
const isScheduler = (command) => /^\s*"?(?:schtasks|crontab)\b/i.test(String(command));

for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const real = childProcess[name];
  childProcess[name] = function refuseScheduler(command, ...rest) {
    if (isScheduler(command)) {
      record(`${name} ${command}`);
      throw new Error(`refused a real scheduler call: ${command}`);
    }
    return real.call(this, command, ...rest);
  };
}
// The CLI is ESM; without this its named child_process imports keep the unpatched functions.
require('node:module').syncBuiltinESMExports();
