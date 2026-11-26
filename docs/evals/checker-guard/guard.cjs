const fs = require('node:fs');
const path = require('node:path');
for (let i = process.execArgv.length - 2; i >= 0; i--) {
  if (process.execArgv[i] === '--require' && path.resolve(process.execArgv[i + 1]) === __filename) process.execArgv.splice(i, 2);
}
const mark = process.env.CHECK_GUARD_MARK;
delete process.env.CHECK_GUARD_MARK;
const crash = error => {
  fs.writeSync(2, 'checker crashed: ' + (error?.stack ?? String(error)) + '\n');
  try {
    if (mark) fs.writeFileSync(mark, 'crash');
  } finally {
    process.exit(2);
  }
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
if (mark) fs.writeFileSync(mark, 'started');
