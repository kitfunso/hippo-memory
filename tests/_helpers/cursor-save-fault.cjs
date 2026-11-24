const fs = require('node:fs');

const HOLD_CAP_MS = 60_000;
const rename = fs.renameSync;

fs.renameSync = function faultedRename(from, to) {
  const fault = process.env.CURSOR_SAVE_FAULT;
  if (fault && String(to).endsWith('.cursor.json')) {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    fs.appendFileSync(process.env.CURSOR_SAVE_MARK, `${process.pid}\n`);
    if (fault === 'kill') {
      process.kill(process.pid, 'SIGKILL');
      // The kill is not instant on every platform, and the rename must never run.
      Atomics.wait(cell, 0, 0, HOLD_CAP_MS);
      process.exit(1);
    }
    for (let waited = 0; waited < HOLD_CAP_MS && !fs.existsSync(process.env.CURSOR_SAVE_RELEASE); waited += 50) {
      Atomics.wait(cell, 0, 0, 50);
    }
  }
  return rename.apply(this, arguments);
};

require('node:module').syncBuiltinESMExports();
