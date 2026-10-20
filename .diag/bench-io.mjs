// Throwaway: per-op cost of the file and SQLite primitives the suite uses, on one folder.
import {
  closeSync,
  copyFileSync,
  cpSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const base = process.argv[2] ?? tmpdir();
const N = Number(process.argv[3] ?? 60);
const tag = process.argv[4] ?? '';
const root = mkdtempSync(join(base, 'hippo-bench-'));
const buf = Buffer.alloc(4096, 7);
const out = [];

function time(label, n, fn) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const ms = (performance.now() - t0) / n;
  out.push(`${tag}${label.padEnd(40)} ${ms.toFixed(2).padStart(8)} ms/op`);
}

time('create 4KB + unlink', N, (i) => {
  const p = join(root, `f${i}`);
  writeFileSync(p, buf);
  unlinkSync(p);
});
const fd = openSync(join(root, 'sync'), 'w');
time('write 4KB + fsync', N, () => {
  writeSync(fd, buf);
  fsyncSync(fd);
});
closeSync(fd);
time('mkdtemp + 3 files + rm -r', N, () => {
  const d = mkdtempSync(join(root, 'd'));
  for (let k = 0; k < 3; k++) writeFileSync(join(d, `${k}`), buf);
  rmSync(d, { recursive: true, force: true });
});

const dbp = join(root, 'w.db');
{
  const db = new DatabaseSync(dbp);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x)');
  db.close();
}
const cycle = (sync, write) => () => {
  const db = new DatabaseSync(dbp);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`PRAGMA synchronous=${sync}`);
  if (write) db.exec('INSERT INTO t VALUES (randomblob(200))');
  else db.prepare('SELECT count(*) FROM t').get();
  db.close();
};
time('sqlite open+read+close (last conn)', N, cycle('NORMAL', false));
time('sqlite open+insert+close (last conn)', N, cycle('NORMAL', true));
time('sqlite open+insert+close sync=OFF', N, cycle('OFF', true));
const holder = new DatabaseSync(dbp);
holder.exec('PRAGMA journal_mode=WAL');
holder.prepare('SELECT 1 FROM t LIMIT 1').get();
time('sqlite open+read+close (held open)', N, cycle('NORMAL', false));
time('sqlite open+insert+close (held open)', N, cycle('NORMAL', true));
time('sqlite insert on held conn', N, () => holder.exec('INSERT INTO t VALUES (randomblob(200))'));
holder.close();

const dist = resolve(import.meta.dirname, '..', 'dist');
if (process.env.BENCH_HIPPO !== '0') {
  const { initStore } = await import(`file://${dist}/store/sqlite/handles.js`);
  const { openHippoDb, closeHippoDb, getHippoDbPath } = await import(`file://${dist}/db/open.js`);
  const tpl = join(root, 'tpl');
  initStore(tpl);
  let k = 0;
  time('copy template hippo.db', N, () => {
    const d = join(root, `c${k++}`);
    mkdirSync(d);
    copyFileSync(getHippoDbPath(tpl), getHippoDbPath(d));
  });
  k = 0;
  time('initStore on a template copy', N, () => initStore(join(root, `c${k++}`)));
  time('openHippoDb+closeHippoDb settled', N, () => closeHippoDb(openHippoDb(tpl)));
  k = 0;
  time('cpSync store folder', Math.min(N, 20), () => cpSync(tpl, join(root, `cp${k++}`), { recursive: true }));
}
rmSync(root, { recursive: true, force: true });
console.log(out.join('\n'));
