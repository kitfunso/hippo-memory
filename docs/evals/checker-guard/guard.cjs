const fs = require('node:fs');
const path = require('node:path');
for (let i = process.execArgv.length - 2; i >= 0; i--) {
  if (process.execArgv[i] === '--require' && path.resolve(process.execArgv[i + 1]) === __filename) process.execArgv.splice(i, 2);
}
const crash = error => {
  fs.writeSync(2, 'checker crashed: ' + (error?.stack ?? String(error)) + '\n');
  process.exit(2);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
