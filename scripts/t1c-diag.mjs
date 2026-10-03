// Temporary: times store operations on a runner disk to find what makes Windows CI slow.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore, writeEntry } from '../dist/store.js';
import { createMemory } from '../dist/memory.js';
import { openHippoDb, closeHippoDb } from '../dist/db.js';

const base = process.argv[2] || os.tmpdir();
const N = 40;
const time = (label, n, fn) => {
  const t = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const ms = (performance.now() - t) / n;
  console.log(`${base}\t${label}\t${ms.toFixed(2)} ms/op`);
};

const root = path.join(fs.mkdtempSync(path.join(base, 'diag-')), '.hippo');
const t0 = performance.now();
initStore(root);
console.log(`${base}\tinitStore\t${(performance.now() - t0).toFixed(1)} ms`);
time('open+close', N, () => closeHippoDb(openHippoDb(root)));
time('writeEntry alone', N, (i) => writeEntry(root, createMemory(`alone memory number ${i} about deploys`)));
const held = openHippoDb(root);
time('writeEntry held', N, (i) => writeEntry(root, createMemory(`held memory number ${i} about deploys`)));
closeHippoDb(held);
const f = path.join(root, 'probe.bin');
time('write+fsync file', 200, () => { const fd = fs.openSync(f, 'w'); fs.writeSync(fd, 'x'.repeat(4096)); fs.fsyncSync(fd); fs.closeSync(fd); });
time('create+unlink file', 200, (i) => { const p = path.join(root, `c${i}.tmp`); fs.writeFileSync(p, 'x'); fs.unlinkSync(p); });
