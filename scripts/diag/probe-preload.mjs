// Preload for benchmarks/a1/p99-recall.ts (node --import): splits each request's wall time into SQLite calls, fs calls, GC and the rest.
// Env: PROBE_AUTOCKPT=<pages> rewrites wal_autocheckpoint; PROBE_OUT=<file>; PROBE_WARMUP, PROBE_QUERIES, PROBE_SLOW_MS.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { PerformanceObserver, performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const sqlite = require('node:sqlite');
const Orig = sqlite.DatabaseSync;
const AUTOCKPT = process.env.PROBE_AUTOCKPT;
const WARMUP = Number(process.env.PROBE_WARMUP ?? 50);
const QUERIES = Number(process.env.PROBE_QUERIES ?? 200);
const SLOW_MS = Number(process.env.PROBE_SLOW_MS ?? 50);
const realStat = fs.statSync;

let acc = null;
let dbPath = null;
const requests = [];
const squash = (sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 70);
const classify = (sql) => {
  const s = sql.trimStart().toUpperCase();
  if (s.startsWith('PRAGMA')) return 'pragma';
  if (/^(COMMIT|END|RELEASE)/.test(s)) return 'commit';
  if (/^(BEGIN|SAVEPOINT|ROLLBACK)/.test(s)) return 'begin';
  if (/^(INSERT|UPDATE|DELETE|REPLACE)/.test(s) || (/^WITH/.test(s) && /\b(INSERT|UPDATE|DELETE)\b/.test(s))) return 'write';
  return 'read';
};
const note = (kind, sql, dt, autocommit) => {
  if (!acc) return;
  acc[kind] = (acc[kind] ?? 0) + dt;
  acc.calls++;
  if (kind === 'write' && autocommit) acc.autoCommits++;
  if (dt > acc.maxDt) { acc.maxDt = dt; acc.maxSql = `${kind}${autocommit ? '(autocommit)' : ''}: ${squash(sql)}`; }
};

class Probe extends Orig {
  constructor(path, o) {
    const t0 = performance.now();
    if (o === undefined) super(path); else super(path, o);
    if (typeof path === 'string' && path.endsWith('hippo.db')) dbPath = path;
    note('open', 'new DatabaseSync', performance.now() - t0, false);
  }
  exec(sql) {
    let s = sql;
    if (AUTOCKPT !== undefined && /wal_autocheckpoint/i.test(s)) s = `PRAGMA wal_autocheckpoint = ${AUTOCKPT}`;
    const t0 = performance.now();
    try { return super.exec(s); } finally { note(classify(s), s, performance.now() - t0, false); }
  }
  close() {
    const t0 = performance.now();
    try { return super.close(); } finally { note('close', 'close', performance.now() - t0, false); }
  }
  prepare(sql) {
    const t0 = performance.now();
    const st = super.prepare(sql);
    note('prepare', sql, performance.now() - t0, false);
    const kind = classify(sql);
    const db = this;
    const wrap = (fn) => (...a) => {
      const auto = kind === 'write' && !db.isTransaction;
      const t1 = performance.now();
      try { return fn.apply(st, a); } finally { note(kind, sql, performance.now() - t1, auto); }
    };
    return new Proxy(st, {
      get(t, p) {
        const v = t[p];
        if (p === 'run' || p === 'get' || p === 'all' || p === 'iterate') return wrap(v);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }
}
sqlite.DatabaseSync = Probe;

for (const name of Object.keys(fs)) {
  if (!name.endsWith('Sync') || typeof fs[name] !== 'function') continue;
  const orig = fs[name];
  fs[name] = function (...a) {
    if (!acc) return orig.apply(this, a);
    const t0 = performance.now();
    try { return orig.apply(this, a); } finally { const dt = performance.now() - t0; acc.fs += dt; acc.fsCalls++; if (dt > acc.maxFsDt) { acc.maxFsDt = dt; acc.maxFs = `${name}(${typeof a[0] === 'string' ? a[0].slice(-40) : typeof a[0]})`; } }
  };
}
// PROBE_STATS picks how stats.json is rewritten: split (open/write/close timed apart), inplace, rename, async, skip.
const STATS = process.env.PROBE_STATS;
if (STATS) {
  const plain = fs.writeFileSync;
  let pending = null;
  let busy = false;
  const flush = () => {
    if (busy || pending === null) return;
    busy = true;
    const [p, d] = pending;
    pending = null;
    fs.writeFile(p, d, 'utf8', () => { busy = false; flush(); });
  };
  fs.writeFileSync = function (p, data, ...rest) {
    if (typeof p !== 'string' || !p.endsWith('stats.json')) return plain.call(this, p, data, ...rest);
    if (STATS === 'skip') return;
    if (STATS === 'async') { pending = [p, data]; flush(); return; }
    if (STATS === 'rename') { fs.writeFileSync(`${p}.tmp`, data, 'utf8'); fs.renameSync(`${p}.tmp`, p); return; }
    const buf = Buffer.from(data, 'utf8');
    let fd;
    if (STATS === 'inplace') {
      try { fd = fs.openSync(p, 'r+'); } catch { fd = fs.openSync(p, 'w'); }
      fs.writeSync(fd, buf, 0, buf.length, 0);
      fs.ftruncateSync(fd, buf.length);
    } else {
      fd = fs.openSync(p, 'w');
      fs.writeSync(fd, buf, 0, buf.length, 0);
    }
    fs.closeSync(fd);
  };
}
syncBuiltinESMExports();

const gcEvents = [];
const gcObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gcEvents.push([e.startTime, e.duration, e.detail?.kind ?? 0]); });
gcObs.observe({ entryTypes: ['gc'] });

const fileState = () => {
  if (!dbPath) return { m: 0n, wal: 0 };
  let wal = 0;
  try { wal = realStat(`${dbPath}-wal`).size; } catch { wal = 0; }
  return { m: realStat(dbPath, { bigint: true }).mtimeNs, wal };
};

const origFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const before = fileState();
  const mine = { open: 0, pragma: 0, read: 0, write: 0, commit: 0, begin: 0, prepare: 0, close: 0, fs: 0, fsCalls: 0, calls: 0, autoCommits: 0, maxDt: 0, maxSql: '', maxFsDt: 0, maxFs: '' };
  acc = mine;
  const wall0 = Date.now();
  const t0 = performance.now();
  const res = await origFetch(...args);
  const text = res.text.bind(res);
  res.text = async () => {
    const body = await text();
    const t1 = performance.now();
    acc = null;
    const after = fileState();
    requests.push({ ...mine, i: requests.length, t0, t1, total: t1 - t0, epoch: wall0 / 1000, ckpt: after.m !== before.m, walBefore: before.wal, walAfter: after.wal, gc: 0, gcMajor: 0 });
    return body;
  };
  return res;
};

const pct = (a, p) => { const x = [...a].sort((m, n) => m - n); return x.length ? x[Math.min(x.length - 1, Math.floor(p * x.length))] : NaN; };
const f = (n) => n.toFixed(1);

process.on('exit', () => {
  for (const e of gcObs.takeRecords()) gcEvents.push([e.startTime, e.duration, e.detail?.kind ?? 0]);
  for (const q of requests) for (const [st, d, kind] of gcEvents) if (st >= q.t0 && st < q.t1) { q.gc += d; if (kind !== 1 && kind !== 8) q.gcMajor += d; }
  const timed = requests.slice(WARMUP);
  const rounds = [];
  for (let i = 0; i < timed.length; i += QUERIES) rounds.push(timed.slice(i, i + QUERIES));
  const sqlTime = (q) => q.open + q.pragma + q.read + q.write + q.commit + q.begin + q.prepare + q.close;
  const out = [];
  out.push(`[probe] autockpt=${AUTOCKPT ?? "store default"} stats=${STATS ?? "store default"} requests=${requests.length} timed=${timed.length}`);
  out.push(`[probe] round p99s: ${rounds.map((r) => f(pct(r.map((q) => q.total), 0.99))).join(' / ')}  p50 ${f(pct(timed.map((q) => q.total), 0.5))} p95 ${f(pct(timed.map((q) => q.total), 0.95))} max ${f(Math.max(...timed.map((q) => q.total)))}`);
  const ck = timed.filter((q) => q.ckpt), nock = timed.filter((q) => !q.ckpt);
  const desc = (xs) => xs.length ? `n=${xs.length} p50 ${f(pct(xs.map((q) => q.total), 0.5))} p99 ${f(pct(xs.map((q) => q.total), 0.99))} max ${f(Math.max(...xs.map((q) => q.total)))} over${SLOW_MS}ms=${xs.filter((q) => q.total > SLOW_MS).length}` : 'n=0';
  out.push(`[probe] requests where the db file was written (a checkpoint ran): ${desc(ck)}`);
  out.push(`[probe] requests with no checkpoint:                              ${desc(nock)}`);
  const mean = (xs, g) => xs.length ? xs.reduce((a, q) => a + g(q), 0) / xs.length : 0;
  out.push(`[probe] mean per request: total ${f(mean(timed, (q) => q.total))} sqlite ${f(mean(timed, sqlTime))} (commit ${f(mean(timed, (q) => q.commit))} write ${f(mean(timed, (q) => q.write))} read ${f(mean(timed, (q) => q.read))} open ${f(mean(timed, (q) => q.open))} pragma ${f(mean(timed, (q) => q.pragma))} prepare ${f(mean(timed, (q) => q.prepare))} close ${f(mean(timed, (q) => q.close))}) fs ${f(mean(timed, (q) => q.fs))} gc ${f(mean(timed, (q) => q.gc))} | calls ${f(mean(timed, (q) => q.calls))} autoCommits ${f(mean(timed, (q) => q.autoCommits))} walGrowthKiB ${f(mean(nock, (q) => (q.walAfter - q.walBefore) / 1024))}`);
  const slow = timed.filter((q) => q.total > SLOW_MS);
  out.push(`[probe] ${slow.length} timed requests over ${SLOW_MS} ms:`);
  for (const q of slow) {
    const other = q.total - sqlTime(q) - q.fs - q.gc;
    out.push(`[probe]   #${q.i} total ${f(q.total)} | commit ${f(q.commit)} write ${f(q.write)} read ${f(q.read)} open ${f(q.open)} pragma ${f(q.pragma)} close ${f(q.close)} prepare ${f(q.prepare)} | fs ${f(q.fs)} gc ${f(q.gc)} (major ${f(q.gcMajor)}) other ${f(other)} | ckpt ${q.ckpt ? 'YES' : 'no'} wal ${Math.round(q.walBefore / 4096)}->${Math.round(q.walAfter / 4096)}pg | slowest sqlite call ${f(q.maxDt)}ms ${q.maxSql} | slowest fs ${f(q.maxFsDt)}ms ${q.maxFs}`);
  }
  const share = (g) => slow.length ? (100 * slow.reduce((a, q) => a + g(q), 0) / slow.reduce((a, q) => a + q.total, 0)).toFixed(0) : '0';
  out.push(`[probe] share of slow-request time: commit+autocommit-write ${share((q) => q.commit + q.write)}% read ${share((q) => q.read)}% open+pragma+close+prepare ${share((q) => q.open + q.pragma + q.close + q.prepare)}% fs ${share((q) => q.fs)}% gc ${share((q) => q.gc)}%`);
  console.log(out.join('\n'));
  if (process.env.PROBE_OUT) fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(requests.map(({ i, epoch, total, ckpt, commit, write, maxDt, maxSql }) => ({ i, epoch, total, ckpt, commit, write, maxDt, maxSql }))));
});
