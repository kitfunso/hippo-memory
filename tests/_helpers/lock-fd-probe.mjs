// POSIX: a worker thread holds a lock, this thread takes through the create path, and a separate process then asks.
// Prints the kind that process got: held, unless this process dropped the worker thread's lock with a raw close.
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { takeFileLock } from '../../dist/host/file-lock.js';

const lockPath = process.argv[2];
const lockUrl = pathToFileURL(join(import.meta.dirname, '..', '..', 'dist', 'host', 'file-lock.js')).href;
const code = `const { parentPort } = require('node:worker_threads');
  import(${JSON.stringify(lockUrl)}).then((m) => { const t = m.takeFileLock(${JSON.stringify(lockPath)});
  parentPort.postMessage(t.kind); setInterval(() => {}, 1 << 30); });`;
const worker = new Worker(code, { eval: true });
const workerKind = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});
let first = true;
const noFileOnce = (p) => {
  if (first) {
    first = false;
    return undefined;
  }
  const s = statSync(p, { bigint: true, throwIfNoEntry: false });
  return s === undefined ? undefined : { dev: s.dev, ino: s.ino, ctimeNs: s.ctimeNs };
};
const mine = takeFileLock(lockPath, noFileOnce);
const probe = `import(${JSON.stringify(lockUrl)}).then((m) => console.log(m.takeFileLock(${JSON.stringify(lockPath)}).kind))`;
const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
console.log(JSON.stringify({ worker: workerKind, main: mine.kind, other: out.stdout.trim() }));
process.exit(0);
