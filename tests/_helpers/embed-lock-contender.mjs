// A process that races for the embedding index lock at a set time, reports what it got, and holds it until told to stop.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseEmbedLock, tryEmbedLock } from '../../dist/store/sqlite/embed-lock.js';

const [root, id, goAt] = process.argv.slice(2);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < Number(goAt)) pause(1);
const token = tryEmbedLock(root);
fs.writeFileSync(path.join(root, `result-${id}.json`), JSON.stringify({ token }));
while (!fs.existsSync(path.join(root, 'done'))) pause(20);
if (token !== null) releaseEmbedLock(root, token);
