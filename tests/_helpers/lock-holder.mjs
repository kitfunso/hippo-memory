// A process that takes a file lock, says HELD, and keeps it until it is killed.
import { takeFileLock } from '../../dist/host/file-lock.js';

const take = takeFileLock(process.argv[2]);
process.stdout.write(take.kind === 'taken' ? 'HELD\n' : `${take.kind}\n`);
// The exit hook keeps `take` reachable: a collected connection frees the lock.
process.on('exit', () => take.kind);
setInterval(() => {}, 1 << 30);
