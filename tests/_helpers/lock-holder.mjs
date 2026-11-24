import { takeFileLock } from '../../dist/host/file-lock.js';

const take = takeFileLock(process.argv[2]);
process.stdout.write(take.kind === 'taken' ? 'HELD\n' : `${take.kind}\n`);
setInterval(() => {}, 1 << 30);
