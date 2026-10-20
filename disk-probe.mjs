// Per-operation latency of the disk work a test store does, with P processes at once, on one directory.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SELF = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PRAGMAS = ['PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL', 'PRAGMA foreign_keys = ON'];
const open = (p) => { const db = new DatabaseSync(p); for (const s of PRAGMAS) db.exec(s); return db; };

function makeTemplate(p) {
  const db = open(p);
  db.exec('BEGIN');
  for (let i = 0; i < 60; i++) db.exec(`CREATE TABLE t${i}(id INTEGER PRIMARY KEY, a TEXT, b TEXT); CREATE INDEX t${i}a ON t${i}(a); CREATE INDEX t${i}b ON t${i}(b)`);
  db.exec('CREATE TABLE m(id INTEGER PRIMARY KEY, c TEXT, d TEXT); CREATE INDEX md ON m(d)');
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

const row = () => ['x'.repeat(300), String(Math.random())];
const OPS = {
  'cycle-read': (ctx) => { const db = open(ctx.db); db.prepare('SELECT count(*) FROM m').get(); db.close(); },
  'cycle-write': (ctx) => { const db = open(ctx.db); db.prepare('INSERT INTO m(c, d) VALUES (?, ?)').run(...row()); db.close(); },
  'held-commit': (ctx) => { ctx.ins.run(...row()); },
  'held-batch100': (ctx) => { ctx.held.exec('BEGIN'); for (let i = 0; i < 100; i++) ctx.ins.run(...row()); ctx.held.exec('COMMIT'); },
  'copy-831k': (ctx, i) => { const p = join(ctx.dir, `c${i}.db`); fs.copyFileSync(ctx.tpl, p); fs.unlinkSync(p); },
  'mirror-file': (ctx, i) => { const d = join(ctx.dir, 'mirror', 'semantic'); fs.mkdirSync(d, { recursive: true }); const p = join(d, `m${i}.md`); fs.writeFileSync(p + '.tmp', 'y'.repeat(800)); fs.renameSync(p + '.tmp', p); },
  'tmpdir': (ctx) => { const d = fs.mkdtempSync(join(ctx.dir, 'd-')); fs.writeFileSync(join(d, 'f'), 'z'); fs.rmSync(d, { recursive: true, force: true }); },
  'fsync-4k': (ctx) => { fs.writeSync(ctx.fd, Buffer.alloc(4096, 1)); fs.fsyncSync(ctx.fd); },
  'store-life': (ctx, i) => {
    const d = fs.mkdtempSync(join(ctx.dir, 's-'));
    const p = join(d, 'hippo.db');
    fs.copyFileSync(ctx.tpl, p);
    for (let k = 0; k < 5; k++) { const db = open(p); db.prepare('INSERT INTO m(c, d) VALUES (?, ?)').run(...row()); db.close(); }
    fs.rmSync(d, { recursive: true, force: true });
  },
};

function child(op, dir, tpl, budgetMs) {
  fs.mkdirSync(dir, { recursive: true });
  const ctx = { dir, tpl, db: join(dir, 'hippo.db') };
  fs.copyFileSync(tpl, ctx.db);
  ctx.held = open(ctx.db);
  ctx.ins = ctx.held.prepare('INSERT INTO m(c, d) VALUES (?, ?)');
  ctx.fd = fs.openSync(join(dir, 'sync.bin'), 'w');
  if (!op.startsWith('held')) { ctx.held.close(); }
  const lat = [];
  const end = performance.now() + budgetMs;
  for (let i = 0; performance.now() < end && i < 100000; i++) { const s = performance.now(); OPS[op](ctx, i); lat.push(performance.now() - s); }
  if (op.startsWith('held')) ctx.held.close();
  fs.closeSync(ctx.fd);
  process.stdout.write(JSON.stringify(lat));
}

async function phase(op, base, tpl, P, budgetMs) {
  const kids = Array.from({ length: P }, (_, k) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', SELF, '--child', op, join(base, `${op}-${P}-${k}`), tpl, String(budgetMs)]);
    let out = '';
    c.stdout.on('data', (b) => (out += b));
    c.stderr.on('data', (b) => process.stderr.write(b));
    c.on('close', () => resolve(out ? JSON.parse(out) : []));
  }));
  const lat = (await Promise.all(kids)).flat().sort((a, b) => a - b);
  const q = (f) => lat[Math.min(lat.length - 1, Math.floor(f * lat.length))] ?? 0;
  const mean = lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length);
  return { op, P, n: lat.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +q(1).toFixed(1) };
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6]));
} else {
  const base = fs.mkdtempSync(join(process.argv[2], 'probe-'));
  const budget = Number(process.argv[3] ?? 10000);
  const tpl = join(base, 'template.db');
  makeTemplate(tpl);
  console.log(`dir ${base} template ${fs.statSync(tpl).size} bytes`);
  const plan = [
    ...['fsync-4k', 'cycle-read', 'cycle-write', 'held-commit', 'held-batch100', 'copy-831k', 'mirror-file', 'tmpdir', 'store-life'].map((op) => [op, 4]),
    ['cycle-write', 1], ['held-commit', 1], ['fsync-4k', 1],
  ];
  for (const [op, P] of plan) console.log(JSON.stringify(await phase(op, base, tpl, P, budget)));
  fs.rmSync(base, { recursive: true, force: true });
}
