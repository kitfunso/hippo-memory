// Joins strace fsync lines (-ttt -T) with the probe's per-request windows: node join-strace.mjs <strace.log> <probe.json> [warmup]
import { readFileSync } from 'node:fs';
const [, , stracePath, probePath, warm = '50'] = process.argv;
const all = [];
for (const line of readFileSync(stracePath, 'utf8').split('\n')) {
  const m = line.match(/^(\d+)\s+(\d+\.\d+)\s+(fsync|fdatasync)\((\d+)<([^>]*)>\)\s+=\s+0\s+<([\d.]+)>/);
  if (m) all.push({ tid: m[1], t: Number(m[2]), call: m[3], file: m[5].endsWith('-wal') ? 'wal' : m[5].endsWith('hippo.db') ? 'db' : 'dir', ms: Number(m[6]) * 1000 });
}
const mainTid = all[0]?.tid;
const reqs = JSON.parse(readFileSync(probePath, 'utf8')).slice(Number(warm));
const pct = (a, p) => { const x = [...a].sort((m, n) => m - n); return x.length ? x[Math.min(x.length - 1, Math.floor(p * x.length))] : NaN; };
const inRounds = all.filter((s) => s.t >= reqs[0].epoch && s.t <= reqs.at(-1).epoch + reqs.at(-1).total / 1000);
const sync = inRounds.filter((s) => s.tid === mainTid), off = inRounds.filter((s) => s.tid !== mainTid);
const byFile = (xs) => JSON.stringify(xs.reduce((a, s) => ({ ...a, [s.file]: (a[s.file] ?? 0) + 1 }), {}));
const dur = (xs) => xs.length ? `p50 ${pct(xs.map((s) => s.ms), 0.5).toFixed(2)} p99 ${pct(xs.map((s) => s.ms), 0.99).toFixed(2)} max ${Math.max(...xs.map((s) => s.ms)).toFixed(2)} ms, over 20 ms: ${xs.filter((s) => s.ms > 20).length}` : '-';
for (const q of reqs) { q.sync = sync.filter((s) => s.t >= q.epoch - 0.001 && s.t <= q.epoch + q.total / 1000 + 0.001); q.syncMs = q.sync.reduce((a, s) => a + s.ms, 0); }
console.log(`[strace] request-thread sync calls in the timed rounds: ${sync.length} ${byFile(sync)} ${dur(sync)}`);
console.log(`[strace] other-thread sync calls in the timed rounds:   ${off.length} ${byFile(off)} ${dur(off)}`);
const withSync = reqs.filter((q) => q.sync.length), without = reqs.filter((q) => !q.sync.length);
const desc = (xs) => xs.length ? `n=${xs.length} p50 ${pct(xs.map((q) => q.total), 0.5).toFixed(1)} p99 ${pct(xs.map((q) => q.total), 0.99).toFixed(1)} max ${Math.max(...xs.map((q) => q.total)).toFixed(1)}` : 'n=0';
console.log(`[strace] requests with a request-thread sync call: ${desc(withSync)}`);
console.log(`[strace] requests with none:                       ${desc(without)}`);
for (const q of reqs.filter((x) => x.total > 50)) console.log(`[strace]   #${q.i} total ${q.total.toFixed(1)} ms: ${q.sync.length} request-thread sync calls taking ${q.syncMs.toFixed(1)} ms (${q.sync.map((s) => `${s.file} ${s.ms.toFixed(1)}`).join(', ')})`);
