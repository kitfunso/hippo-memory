// The built CLI, counting the SQLite connections it holds: node dashboard-connections-cli.mjs <report file> <hippo args>
// As it exits it writes { atSignal, atExit } to the report file. A line on stdin raises SIGINT in-process, the way Ctrl+C arrives on Windows.
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from '../../dist/cli.js';

const reportFile = process.argv[2];
process.argv.splice(2, 1);

const open = new Set();
for (const method of ['exec', 'prepare']) {
  const real = DatabaseSync.prototype[method];
  DatabaseSync.prototype[method] = function (...args) {
    open.add(this);
    return real.apply(this, args);
  };
}
const close = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function () {
  open.delete(this);
  return close.call(this);
};

let atSignal = null;
const note = () => {
  atSignal = open.size;
};
// Ahead of the CLI's own handlers, so the count is taken before they close anything.
process.prependListener('SIGINT', note);
process.prependListener('SIGTERM', note);
process.on('exit', () => writeFileSync(reportFile, JSON.stringify({ atSignal, atExit: open.size })));
process.stdin.once('data', () => process.emit('SIGINT'));

runCli();
