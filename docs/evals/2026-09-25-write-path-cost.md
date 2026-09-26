# Write-path cost by step (2026-09-25)

Measured on the Windows work box on 1.46.0 (08592c1), while picking a roadmap item that would not overlap the home session. It feeds the ROADMAP item "Fix the write path's per-write cost, which grows with store size" (90-day queue, weeks 0-4) and breaks down the one-write figures in ROADMAP's "Capture and scale findings (2026-09-24, measured)".

Medians of 15 runs (7 for the CLI rows), in a store seeded with 2,000 and then 10,000 memories. The CLI rows include Node start-up, so read their growth, not their level.

| Step | 2k (ms) | 10k (ms) |
|---|---:|---:|
| `writeEntry`, total | 26.6 | 66.7 |
| `index.json` rebuild (`buildIndexFromDb` + `writeIndexMirror`) | 13.3 | 47.3 |
| `loadAllEntries` | 23.1 | 74.9 |
| `computeSchemaFit` | 4.3 | 23.6 |
| `updateStats` | 14.4 | 20.7 |
| `openHippoDb` + close | 5.2 | 8.5 |
| `initStore` | 5.8 | 9.4 |
| CLI `remember` | 308.4 | 457.5 |
| CLI `status` | 277.9 | 389.9 |

Line numbers are for master at 1.47.0 (7ddb58a).

1. **The `index.json` rebuild is about 34 of the 40 ms that `writeEntry` grows from 2k to 10k.** It is rebuilt from the whole table in `syncMirrorFiles` (`src/store.ts:1515`), `saveIndex` (1555), `writeEntryMirrors` (1720), `deleteEntry` (2071) and `batchWriteAndDelete` (2263). `saveIndex` also runs on the recall paths, at `src/cli.ts:2059` and `src/api.ts:2873`.
2. **A release promise was not kept.** `CHANGELOG.md:145`, in the 1.45.0 notes, says `index.json` stops being refreshed on every write in 1.46.0, and `README.md:259` repeats it. The refresh is still there in 1.47.0. Either ship the cut, which is also the biggest write-path win, or correct both docs.
3. **`remember` reads every memory.** It loads all entries (75 ms at 10k) and runs `computeSchemaFit` over them (24 ms). The capture hook's duplicate check (`src/capture.ts:522`) and capture-error's repeat check (`src/capture-error.ts:122`) load all entries too.
4. **Every CLI start pays about 23 ms for an scrypt hash it rarely needs.** `src/auth.ts:32` computes `DUMMY_HASH` when the module loads, so that a failed API-key check costs as much as a good one. Computing it on first use keeps that property and takes the cost off every other command.
5. **Every database open counts two tables.** `backfillFtsIndex` counts `memories` and `memories_fts` (`src/db.ts:2824-2827`) to decide whether to backfill. In one profiled `remember` at 10k those counts took 24 ms, and `openHippoDb` took 119 ms in all across the command's opens. One profiled run, so treat both as rough.
6. **CD13 adds one database open per failed tool call** in the capture-error hook, on top of what it already did. Accepted: one open, not a scan.

The same per-call cost shows in `tests/server-outcome-route.test.ts` "1000 ids at boundary", at about 13 ms per lookup of a missing id. The test takes 12-14 s alone on both 1.46.0 and 1.47.0, and 25-30 s in a full local suite, against a 30 s budget; its own comment expects 5-10 s. Re-time it after the fix rather than raising the timeout.

## After the fix (2026-09-26, home box)

Branch `perf/write-path-cost`, from master at 1.47.0 (8c48355). The same probe, re-run on the home box before and after, so the two columns are comparable with each other and not with the work-box table above.

| Step | Before 2k | Before 10k | After 2k | After 10k |
|---|---:|---:|---:|---:|
| `writeEntry`, total | 17.6 | 52.2 | 9.4 | 14.2 |
| `initStore` | 2.3 | 5.7 | 2.7 | 5.7 |
| `openHippoDb` + close | 2.1 | 5.0 | 2.2 | 5.1 |
| CLI `remember` | 181.0 | 317.0 | 167.4 | 263.4 |

Two changes:

1. **`index.json` is written only by `rebuildIndex()`.** The five write paths above, plus the post-commit refresh in `src/reject-flow.ts`, no longer call `writeIndexMirror`. No reader in `src/` needs the file: `loadIndex` reads SQLite, and the only file reader is the legacy markdown bootstrap.
2. **A new memory skips the full-text delete.** `memories_fts` declares `id UNINDEXED`, so `DELETE FROM memories_fts WHERE id = ?` scans every row. That scan was the rest of the growth: 0.17 ms at 2k and 0.94 ms at 10k. `upsertEntryRow` now checks whether the row exists and skips the delete for a new one. The database-only write (`writeEntryDbOnly`) is flat after the change, 0.39 ms at 2k and 0.41 ms at 10k.

**The acceptance rule.** The growth that remains should come from opening the store, which every command pays, not from the write: `growth(writeEntry) - growth(initStore) - growth(open_close) <= 2 ms`. After the fix: 4.8 - 3.0 - 2.9 = -1.1 ms, a pass. With only the `index.json` cut it was 3.2 ms, a fail, which is what led to the full-text fix.

**Finding 5 does not reproduce.** In a fresh process per run, like a CLI start, `openHippoDb` took 3.0 ms at 2k and 4.4 ms at 10k, and the two backfill counts took 0.1 to 0.5 ms (medians of 7, `open-cost.mjs` below). The 24 ms came from one profiled run.

**"1000 ids at boundary" is not a write-path cost.** It takes 3.07 s alone before and 2.9 to 3.0 s after on this box, and 3.8 s in a full suite. The 997 missing ids never reach a write: `outcome()` (`src/api.ts:1697`) calls `readEntry` per id, and `readEntry` runs `initStore` plus a database open and close each time, about 3 ms. Opening the database once per request would fix it; that is a separate change.

Still open:

- Updates and deletes still pay the full-text scan (`syncFtsRow` on the patch path, `deleteFtsRow`). The structural fix is an external-content FTS table or an id lookup table, which is a schema migration.
- The duplicate checks in capture, capture-error and `remember` still load every memory. An indexed check needs a normalised-content column, which is also a migration.
- Finding 4 (`DUMMY_HASH` computed at module load) is unchanged.

## Probe scripts

All three import from `dist/`, so run `npm run build` first.

`node write-cost-probe.mjs <repo> [out.json]` regenerates the table:

```js
// Times one write's parts at two store sizes. Usage: node write-cost-probe.mjs <repo> [out.json]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2];
const dist = (m) => pathToFileURL(join(repo, 'dist', m)).href;
const { createMemory } = await import(dist('memory.js'));
const store = await import(dist('store.js'));
const { openHippoDb, closeHippoDb } = await import(dist('db.js'));
const { computeSchemaFit } = await import(dist('memory.js'));

const WORDS = 'deploy cache index query latency schema migration tenant recall sleep decay vector token budget hook agent session compact error retry lock mirror export import pipeline'.split(' ');
const TAGS = Array.from({ length: 50 }, (_, i) => `topic-${i}`);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const text = () => Array.from({ length: 26 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const tags = () => [TAGS[Math.floor(rnd() * 50)], TAGS[Math.floor(rnd() * 50)]];

function seedStore(n) {
  const home = mkdtempSync(join(tmpdir(), `hippo-wc-${n}-`));
  const root = join(home, '.hippo');
  store.initStore(root);
  const db = openHippoDb(root);
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) store.writeEntryDbOnly(db, createMemory(text(), { tags: tags(), tenantId: 'default' }));
  db.exec('COMMIT');
  closeHippoDb(db);
  return { home, root };
}

function median(fn, runs = 15) {
  const t = [];
  for (let i = 0; i < runs; i++) {
    const s = process.hrtime.bigint();
    fn();
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}

const out = {};
for (const n of [2000, 10000]) {
  const { home, root } = seedStore(n);
  const r = {};
  r.writeEntry_total = median(() => store.writeEntry(root, createMemory(text(), { tags: tags(), tenantId: 'default' })));
  r.index_mirror = median(() => {
    const db = openHippoDb(root);
    try { store.writeIndexMirror(root, store.buildIndexFromDb(db)); } finally { closeHippoDb(db); }
  });
  r.initStore = median(() => store.initStore(root));
  r.open_close = median(() => closeHippoDb(openHippoDb(root)));
  let existing;
  r.loadAllEntries = median(() => { existing = store.loadAllEntries(root, 'default'); });
  r.schemaFit = median(() => computeSchemaFit(text(), tags(), existing));
  r.updateStats = median(() => store.updateStats(root, { remembered: 1 }));
  // CLI end to end: node startup included, so read the 2k-to-10k difference, not the level.
  const env = { ...process.env, HIPPO_HOME: join(home, 'global'), HIPPO_TENANT: 'default' };
  r.cli_remember = median(() => execFileSync(process.execPath, [join(repo, 'bin', 'hippo.js'), 'remember', text(), '--force'], { cwd: home, env, stdio: 'pipe' }), 7);
  r.cli_status = median(() => execFileSync(process.execPath, [join(repo, 'bin', 'hippo.js'), 'status'], { cwd: home, env, stdio: 'pipe' }), 7);
  out[n] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
```

`node cli-profile.mjs <repo> 10000 -- remember "some text" --force` gives the scrypt and count figures:

```js
// Seeds a store, CPU-profiles one CLI command, prints time by function. Usage: node cli-profile.mjs <repo> <n> -- <hippo args...>
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const [repo, nRaw, , ...hippoArgs] = process.argv.slice(2);
const dist = (m) => pathToFileURL(join(repo, 'dist', m)).href;
const { createMemory } = await import(dist('memory.js'));
const store = await import(dist('store.js'));
const { openHippoDb, closeHippoDb } = await import(dist('db.js'));

const WORDS = 'deploy cache index query latency schema migration tenant recall sleep decay vector token budget hook agent session compact error retry lock mirror export import pipeline'.split(' ');
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const text = () => Array.from({ length: 26 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const home = mkdtempSync(join(tmpdir(), 'hippo-prof-'));
const root = join(home, '.hippo');
store.initStore(root);
const db = openHippoDb(root);
db.exec('BEGIN');
for (let i = 0; i < Number(nRaw); i++) store.writeEntryDbOnly(db, createMemory(text(), { tags: [`topic-${i % 50}`], tenantId: 'default' }));
db.exec('COMMIT');
closeHippoDb(db);
const env = { ...process.env, HIPPO_HOME: join(home, 'global'), HIPPO_TENANT: 'default' };
const profDir = join(home, 'prof');
// Warm run first so the profiled run sees a checkpointed WAL, like a real store.
execFileSync(process.execPath, [join(repo, 'bin', 'hippo.js'), 'status'], { cwd: home, env, stdio: 'pipe' });
execFileSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${profDir}`, join(repo, 'bin', 'hippo.js'), ...hippoArgs], { cwd: home, env, stdio: 'pipe' });
const prof = JSON.parse(readFileSync(join(profDir, readdirSync(profDir)[0]), 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = prof.timeDeltas;
prof.samples.forEach((id, i) => {
  const n = byId.get(id);
  const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
});
// Inclusive time per function: walk parents.
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const incl = new Map();
prof.samples.forEach((id, i) => {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const n = byId.get(cur);
    const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    incl.set(key, (incl.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
});
const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${f}`).join('\n');
console.log(`total ${((prof.endTime - prof.startTime) / 1000).toFixed(0)} ms\n--- inclusive (hippo files) ---`);
console.log(top(new Map([...incl].filter(([k]) => /\.js:/.test(k) && !/node:|internal/.test(k))), 40));
console.log('--- self ---');
console.log(top(self, 15));
rmSync(home, { recursive: true, force: true });
```

`node open-cost.mjs <repo>` times a cold database open and the two backfill counts:

```js
// Seeds 2k/10k stores, then in fresh processes times openHippoDb and the two FTS backfill counts (cold, like a CLI start).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo = process.argv[2];
const dist = (m) => pathToFileURL(join(repo, 'dist', m)).href;
if (process.argv[3] === 'child') {
  const { openHippoDb, closeHippoDb } = await import(dist('db.js'));
  const root = process.argv[4];
  let s = process.hrtime.bigint(); const db = openHippoDb(root); const open = Number(process.hrtime.bigint() - s) / 1e6;
  const t = (sql) => { const s = process.hrtime.bigint(); db.prepare(sql).get(); return Number(process.hrtime.bigint() - s) / 1e6; };
  const c1 = t('SELECT COUNT(*) c FROM memories'); const c2 = t('SELECT COUNT(*) c FROM memories_fts');
  closeHippoDb(db);
  console.log(JSON.stringify({ open, count_memories: c1, count_fts_warm_after_open: c2 }));
  process.exit(0);
}
const { createMemory } = await import(dist('memory.js'));
const store = await import(dist('store.js'));
const { openHippoDb, closeHippoDb } = await import(dist('db.js'));
for (const n of [2000, 10000]) {
  const home = mkdtempSync(join(tmpdir(), `hippo-oc-${n}-`)); const root = join(home, '.hippo');
  store.initStore(root); const db = openHippoDb(root); db.exec('BEGIN');
  for (let i = 0; i < n; i++) store.writeEntryDbOnly(db, createMemory('deploy cache index query latency schema migration tenant recall sleep decay vector ' + i, { tags: ['t' + (i % 50)], tenantId: 'default' }));
  db.exec('COMMIT'); closeHippoDb(db);
  const runs = Array.from({ length: 7 }, () => JSON.parse(execFileSync(process.execPath, [process.argv[1], repo, 'child', root], { stdio: ['ignore', 'pipe', 'ignore'] }).toString()));
  const med = (k) => runs.map((r) => r[k]).sort((a, b) => a - b)[3].toFixed(2);
  console.log(n, 'open', med('open'), 'count_memories', med('count_memories'), 'count_fts', med('count_fts_warm_after_open'));
  rmSync(home, { recursive: true, force: true });
}
```
