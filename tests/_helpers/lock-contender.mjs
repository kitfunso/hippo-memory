// A process that says `ready <id>`, races for a file lock on a `go` line, prints `result <kind>`, and holds it until stdin ends.
import { takeFileLock } from '../../dist/host/file-lock.js';

const [lockPath, id] = process.argv.slice(2);
let take;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (take !== undefined || !input.includes('go\n')) return;
  take = takeFileLock(lockPath);
  process.stdout.write(`result ${take.kind}\n`);
});
process.stdin.on('end', () => {
  if (take?.kind === 'taken') take.lock.release();
});
process.stdout.write(`ready ${id}\n`);
