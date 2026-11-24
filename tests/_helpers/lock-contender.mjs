import * as fs from 'node:fs';
import * as path from 'node:path';
import { takeFileLock } from '../../dist/host/file-lock.js';

const [dir, id, lockName] = process.argv.slice(2);
const mark = (name) => path.join(dir, name);
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
const wait = (name) => {
  while (!fs.existsSync(mark(name))) pause();
};
fs.writeFileSync(mark(`ready-${id}`), '');
wait('go');
const take = takeFileLock(path.join(dir, lockName));
fs.writeFileSync(mark(`result-${id}.json.part`), JSON.stringify({ kind: take.kind }));
fs.renameSync(mark(`result-${id}.json.part`), mark(`result-${id}.json`));
wait('done');
if (take.kind === 'taken') take.lock.release();
