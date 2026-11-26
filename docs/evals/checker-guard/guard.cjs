const fs = require('node:fs');
const path = require('node:path');
for (let i = process.execArgv.length - 2; i >= 0; i--) {
  if (process.execArgv[i] === '--require' && path.resolve(process.execArgv[i + 1]) === __filename) process.execArgv.splice(i, 2);
}
const channel = process.env.CHECK_GUARD_FD, nonce = process.env.CHECK_GUARD_NONCE;
delete process.env.CHECK_GUARD_FD;
delete process.env.CHECK_GUARD_NONCE;
const signal = state => { if (channel !== undefined && nonce) fs.writeSync(Number(channel), state + ' ' + nonce + '\n'); };
const crash = error => {
  fs.writeSync(2, 'checker crashed: ' + (error?.stack ?? String(error)) + '\n');
  try {
    signal('crash');
  } finally {
    process.exit(2);
  }
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
signal('started');
