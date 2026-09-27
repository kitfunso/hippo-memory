#!/usr/bin/env node
// Z1c judge-gated failure recall eval: prereg docs/evals/2026-09-27-z1c-judge-gate-prereg.md.
// Prints AGGREGATE NUMBERS ONLY to stdout: never transcript, command, error, memory text or private paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

const SINCE = '2026-09-26T23:00:00.000Z';
const CONFIG = { metric: 'jaccard', threshold: 0.08, minShared: 2, maxItems: 3 };
const MIN_EVENTS = 30;
const SEED = 20260927;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'z1-replay.mjs');
const JUDGE_PROMPT =
  'For each item you get a failed shell command, its error output, and a few notes from a memory store. ' +
  'Answer HELPS if at least one note contains specific information that would help an engineer fix or avoid ' +
  'this exact failure: its cause, a fix, the right command or flag, a path or naming rule, or a known gotcha ' +
  'that applies. Answer NO if the notes are only on the same topic, generic, or unrelated. Output one line ' +
  'per item: `<item id> HELPS` or `<item id> NO`.';

function parseArgs(argv) {
  const out = { dryRun: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--projects') out.projects = argv[++i];
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--dry-run') out.dryRun = Number(argv[++i]);
    else if (a === '--selftest') out.selftest = true;
  }
  return out;
}

// shared math (used by main flow and --selftest)

// Same PRNG as z1-replay.mjs: Math.random is banned for reproducibility.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Recurrence pmf(k) from pmf(k-1) avoids BigInt overflow for larger n.
function signTestP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let pmf = Math.pow(0.5, n);
  let sum = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) pmf = (pmf * (n - k + 1)) / k;
    if (k >= b) sum += pmf;
  }
  return Math.min(1, sum);
}

function kappa(labelsA, labelsB) {
  const n = labelsA.length;
  if (n === 0) return null;
  let agree = 0, aYes = 0, bYes = 0;
  for (let i = 0; i < n; i++) {
    if (labelsA[i] === labelsB[i]) agree++;
    if (labelsA[i] === 'HELPS') aYes++;
    if (labelsB[i] === 'HELPS') bYes++;
  }
  const po = agree / n;
  const pA = aYes / n, pB = bYes / n;
  const pe = pA * pB + (1 - pA) * (1 - pB);
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

function parseLabels(text) {
  // Judges also echo the "### Item N" header with the label on the next line; the prompt is locked, so parse both.
  const map = new Map();
  let pending = null;
  for (const line of String(text).split(/\r?\n/)) {
    const one = /^[\s#*]*(?:item\s*)?(\d+)[\s:.)*-]*(HELPS|NO)\b/i.exec(line);
    const head = /^[\s#*]*item\s*(\d+)[\s:*]*$/i.exec(line);
    const bare = /^[\s*]*(HELPS|NO)[\s*.]*$/i.exec(line);
    if (one) { map.set(Number(one[1]), one[2].toUpperCase()); pending = null; }
    else if (head) pending = Number(head[1]);
    else if (bare && pending !== null) { map.set(pending, bare[1].toUpperCase()); pending = null; }
  }
  return map;
}

// Cyclic derangement (no fixed points, ever) then a greedy pass to swap same-session mappings apart.
function buildDerangement(sessions, seed) {
  const n = sessions.length;
  if (n < 2) return [];
  const order = seededShuffle([...Array(n).keys()], seed);
  const pi = new Array(n);
  for (let k = 0; k < n; k++) pi[order[k]] = order[(k + 1) % n];
  for (let pass = 0; pass < n; pass++) {
    let improved = false;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const j = pi[i];
      if (sessions[i] !== sessions[j]) continue;
      for (let k2 = 0; k2 < n; k2++) {
        const i2 = order[k2];
        if (i2 === i) continue;
        const j2 = pi[i2];
        if (j2 === i || j === i2) continue; // would create a fixed point
        if (sessions[i] !== sessions[j2] && sessions[i2] !== sessions[j]) {
          pi[i] = j2;
          pi[i2] = j;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return pi;
}

// Prereg amendment 1: base64 thinking signatures and image data contain "z1c" by chance, so drop them and match a whole token.
const BASE64_KEYS = new Set(['signature', 'data']);
function mentionsZ1c(line) {
  let s = line;
  try { s = JSON.stringify(JSON.parse(line), (k, v) => (BASE64_KEYS.has(k) && typeof v === 'string' ? '' : v)); } catch { /* raw line */ }
  return /\bz1c\b/i.test(s);
}

function normPath(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isPathInside(child, parent) {
  const c = normPath(child), pp = normPath(parent);
  if (c === pp) return true;
  const rel = path.relative(pp, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// step 1: collect transcripts
function collect(projectsDir, outDir) {
  const kept = [];
  const excluded = { z1c: 0, evalRuns: 0, scratch: 0, stale: 0 };
  const cwds = new Set();
  let latestTs = -Infinity;
  const sinceMs = Date.parse(SINCE);

  const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const pd of projectDirs) {
    const dirPath = path.join(projectsDir, pd.name);
    const files = fs.readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
    for (const f of files) {
      const filePath = path.join(dirPath, f.name);
      const text = fs.readFileSync(filePath, 'utf8');
      if (text.split(/\r?\n/).some((l) => l && mentionsZ1c(l))) { excluded.z1c++; continue; }
      let hasEvalRuns = false, hasScratch = false, hasRecent = false;
      const fileCwds = new Set();
      let fileMaxTs = -Infinity;
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.cwd) {
          fileCwds.add(o.cwd);
          const segs = String(o.cwd).split(/[\\/]/);
          if (segs.includes('eval-runs')) hasEvalRuns = true;
          if (isPathInside(o.cwd, outDir)) hasScratch = true;
        }
        if (o.timestamp) {
          const t = Date.parse(o.timestamp);
          if (!Number.isNaN(t) && t >= sinceMs) { hasRecent = true; if (t > fileMaxTs) fileMaxTs = t; }
        }
      }
      if (hasEvalRuns) { excluded.evalRuns++; continue; }
      if (hasScratch) { excluded.scratch++; continue; }
      if (!hasRecent) { excluded.stale++; continue; }
      const destDir = path.join(outDir, 'corpus', pd.name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(filePath, path.join(destDir, f.name));
      kept.push({ project: pd.name, file: f.name });
      for (const c of fileCwds) cwds.add(c);
      if (fileMaxTs > latestTs) latestTs = fileMaxTs;
    }
  }
  return { kept, excluded, cwds, latestTs };
}

// step 2: store copies via VACUUM INTO from a read-only connection
function vacuumCopy(srcDb, destDb) {
  if (!fs.existsSync(srcDb)) return false;
  fs.mkdirSync(path.dirname(destDb), { recursive: true });
  const db = new DatabaseSync(srcDb, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return true;
}

function findStoreRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    let isHippo = false;
    try { isHippo = fs.statSync(path.join(dir, '.hippo')).isDirectory(); } catch { /* keep climbing */ }
    if (isHippo) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function collectStores(home, cwds, outDir) {
  const roots = new Map(); // normPath -> original root
  for (const cwd of cwds) {
    const root = findStoreRoot(cwd);
    if (!root || normPath(root) === normPath(home)) continue;
    roots.set(normPath(root), root);
  }
  const sortedRoots = [...roots.values()].sort();
  const stores = [];
  sortedRoots.forEach((root, i) => {
    const dir = path.join(outDir, 'stores', String(i));
    if (vacuumCopy(path.join(root, '.hippo', 'hippo.db'), path.join(dir, 'hippo.db'))) stores.push({ root, dir });
  });
  vacuumCopy(path.join(home, '.hippo', 'hippo.db'), path.join(outDir, 'global', 'hippo.db'));
  return stores;
}

// step 3: replay
function runReplay(outDir, home, stores) {
  const args = [
    REPLAY_SCRIPT, '--arm', 'z1b', '--mode', 'final', '--split', 'all', '--since', SINCE,
    '--config', JSON.stringify(CONFIG),
    '--corpus', path.join(outDir, 'corpus'),
    '--global', path.join(outDir, 'global'),
    '--home', home,
    ...stores.flatMap((s) => ['--store', `${s.root}=${s.dir}`]),
    '--judge-out', path.join(outDir, 'judge', 'export.json'),
  ];
  fs.mkdirSync(path.join(outDir, 'judge'), { recursive: true });
  return spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 200 });
}

// judge invocation (steps 8-9)
function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  // Only a real .exe: Node refuses to spawn a .cmd shim with shell:false, and a shell would re-quote the prompt.
  const r = spawnSync('where', ['claude'], { encoding: 'utf8' });
  const exe = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
  if (!exe) throw new Error('claude.exe not found on PATH');
  return exe;
}

function callClaude(model, prompt, cwd) {
  const exe = resolveClaudeExe();
  const args = [
    '-p', '--safe-mode', '--model', model, '--tools', '', '--no-session-persistence', '--strict-mcp-config',
    '--system-prompt', 'You label items. Follow the user message exactly.',
  ];
  return spawnSync(exe, args, { cwd, input: prompt, encoding: 'utf8', timeout: 600000, shell: false, maxBuffer: 1024 * 1024 * 20 });
}

function renderItem(it) {
  const notes = it.memories.length ? it.memories.map((m) => `- ${m}`).join('\n') : '- (none)';
  return `### Item ${it.itemId}\nCommand:\n${it.command}\nError:\n${it.error}\nNotes:\n${notes}`;
}

// Batches of 20; a batch missing any id is re-asked once; still missing => VOID (null labels).
function judge(model, items, judgeCwd) {
  const labels = new Map();
  let retries = 0;
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20);
    const prompt = `${JUDGE_PROMPT}\n\n${batch.map(renderItem).join('\n\n')}`;
    let parsed = parseLabels(callClaude(model, prompt, judgeCwd).stdout);
    let missing = batch.filter((it) => !parsed.has(it.itemId));
    if (missing.length) {
      retries++;
      const parsed2 = parseLabels(callClaude(model, prompt, judgeCwd).stdout);
      for (const [k, v] of parsed2) parsed.set(k, v);
      missing = batch.filter((it) => !parsed.has(it.itemId));
      if (missing.length) return { labels: null, retries };
    }
    for (const it of batch) labels.set(it.itemId, parsed.get(it.itemId));
  }
  return { labels, retries };
}

function readHeadings(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^\s*#/.test(l)).map((l) => l.trim()).filter(Boolean);
}

function isolationOk(model, home, judgeCwd) {
  const prompt =
    'List every markdown section heading (lines starting with #) that appears anywhere in your context other ' +
    'than this message, one per line, verbatim. If there are none, reply NONE.';
  const reply = callClaude(model, prompt, judgeCwd).stdout || '';
  const headings = [...readHeadings(path.join(home, '.claude', 'CLAUDE.md')), ...readHeadings(path.join(home, 'CLAUDE.md'))];
  return !headings.some((h) => reply.includes(h));
}

// judge set construction (step 6)
function buildJudgeSet(outDir, dryRun) {
  const items = JSON.parse(fs.readFileSync(path.join(outDir, 'judge', 'export.json'), 'utf8')).items;
  const key = JSON.parse(fs.readFileSync(path.join(outDir, 'judge', 'export.json.key.json'), 'utf8'));
  const itemById = new Map(items.map((it) => [it.itemId, it]));
  const events = new Map();
  for (const k of key) {
    const content = itemById.get(k.itemId);
    if (!events.has(k.eventId)) events.set(k.eventId, { session: k.session });
    events.get(k.eventId)[k.arm] = { ...content, autoNo: k.autoNo };
  }
  let eventIds = [...events.keys()].sort((a, b) => a - b);
  if (dryRun !== null) eventIds = eventIds.slice(0, dryRun);

  const pi = eventIds.length >= 2 ? buildDerangement(eventIds.map((id) => events.get(id).session), SEED) : [];
  const judged = [];
  for (let i = 0; i < eventIds.length; i++) {
    const id = eventIds[i];
    const ev = events.get(id);
    judged.push({ eventId: id, arm: 'T', command: ev.T.command, error: ev.T.error, memories: ev.T.memories });
    if (!ev.C.autoNo) judged.push({ eventId: id, arm: 'C', command: ev.C.command, error: ev.C.error, memories: ev.C.memories });
    if (pi.length) {
      const partner = events.get(eventIds[pi[i]]);
      judged.push({ eventId: id, arm: 'P', command: partner.T.command, error: partner.T.error, memories: ev.T.memories });
    }
  }

  const shuffled = seededShuffle(judged, SEED);
  const finalItems = shuffled.map((it, idx) => ({ itemId: idx, command: it.command, error: it.error, memories: it.memories }));
  const finalKey = shuffled.map((it, idx) => ({ itemId: idx, eventId: it.eventId, arm: it.arm }));
  fs.writeFileSync(path.join(outDir, 'judge', 'items.json'), JSON.stringify(finalItems, null, 2));
  fs.writeFileSync(path.join(outDir, 'judge', 'key.json'), JSON.stringify(finalKey, null, 2));
  return { events, eventIds, items: finalItems, key: finalKey };
}

// scoring (step 10)
function scoreArm(eventIds, events, key, sonnetLabels, opusLabels, arm) {
  const idxByEventArm = new Map();
  for (const k of key) if (k.arm === arm) idxByEventArm.set(k.eventId, k.itemId);
  let helps = 0;
  const sLabels = [], oLabels = [];
  for (const id of eventIds) {
    const ev = events.get(id);
    if (arm === 'C' && ev.C.autoNo) { sLabels.push('NO'); oLabels.push('NO'); continue; }
    const itemId = idxByEventArm.get(id);
    const s = sonnetLabels.get(itemId), o = opusLabels.get(itemId);
    sLabels.push(s); oLabels.push(o);
    if (s === 'HELPS' && o === 'HELPS') helps++;
  }
  return { rate: eventIds.length ? helps / eventIds.length : 0, sLabels, oLabels };
}

function score(outDir, eventIds, events, key, sonnetLabels, opusLabels, rr) {
  const t = scoreArm(eventIds, events, key, sonnetLabels, opusLabels, 'T');
  const c = scoreArm(eventIds, events, key, sonnetLabels, opusLabels, 'C');
  const pEventIds = key.filter((k) => k.arm === 'P').map((k) => k.eventId);
  const p = pEventIds.length ? scoreArm(pEventIds, events, key, sonnetLabels, opusLabels, 'P') : { rate: 0, sLabels: [], oLabels: [] };

  let b = 0, c2 = 0;
  for (let i = 0; i < eventIds.length; i++) {
    const tHelps = t.sLabels[i] === 'HELPS' && t.oLabels[i] === 'HELPS';
    const cHelps = c.sLabels[i] === 'HELPS' && c.oLabels[i] === 'HELPS';
    if (tHelps && !cHelps) b++;
    if (cHelps && !tHelps) c2++;
  }
  const pValue = signTestP(b, c2);
  const allS = [...key].map((k) => sonnetLabels.get(k.itemId));
  const allO = [...key].map((k) => opusLabels.get(k.itemId));
  const kap = kappa(allS, allO);

  const tokens = rr.all.A1.tokens, z1bTokens = rr.all.Z1b.tokens;
  const ratio = tokens.mean ? z1bTokens.mean / tokens.mean : null;
  const validity = pEventIds.length > 0 && p.rate <= 0.10;
  const judgeGate = eventIds.length >= MIN_EVENTS && t.rate >= 0.30 && t.rate - c.rate >= 0.15 && pValue < 0.05;
  const tokensGate = ratio !== null && ratio <= 1.20 && tokens.hookPrompts >= 200;
  const verdict = !validity ? 'VOID' : judgeGate && tokensGate ? 'PASS' : 'FAIL';

  const result = {
    eligible: eventIds.length,
    T: { rate: t.rate }, C: { rate: c.rate }, P: { rate: p.rate },
    discordant: { b, c: c2 }, signTestP: pValue, kappa: kap,
    tokens: { ratio, hookPrompts: tokens.hookPrompts },
    gates: { validity, judge: judgeGate, tokens: tokensGate },
    latency: 'not measured: needs hook code, gated on judge+tokens',
    verdict,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

function selftest() {
  assert.equal(signTestP(14, 0), Math.pow(2, -14));
  assert.equal(signTestP(0, 0), 1);
  assert.equal(kappa(['HELPS', 'NO', 'HELPS', 'NO'], ['HELPS', 'NO', 'HELPS', 'NO']), 1);

  const pi2 = buildDerangement(['a', 'b'], SEED);
  assert.ok(pi2.every((v, i) => v !== i));
  const pi3 = buildDerangement(['a', 'a', 'b'], SEED);
  assert.ok(pi3.every((v, i) => v !== i));
  const violations = pi3.reduce((n, v, i) => n + (['a', 'a', 'b'][v] === ['a', 'a', 'b'][i] ? 1 : 0), 0);
  assert.ok(violations <= 1);

  assert.equal(mentionsZ1c(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x', signature: 'ab+Z1c/q' }] } })), false);
  assert.equal(mentionsZ1c(JSON.stringify({ cwd: '/w/hippo-wt-z1c' })), true);
  assert.equal(mentionsZ1c('run scripts/z1c-eval.mjs'), true);

  const parsed = parseLabels('Sure, here are labels:\n0 HELPS\nnoise line\n1 NO\nabc HELPS\n2x HELPS');
  assert.equal(parsed.get(0), 'HELPS');
  assert.equal(parsed.get(1), 'NO');
  assert.equal(parsed.has(2), false);
  const echoed = parseLabels('### Item 0\nNO\n\n### Item 1\n**HELPS**\nItem 2: HELPS\n### Item 3\n\nnote text\nNO');
  assert.equal(echoed.get(0), 'NO');
  assert.equal(echoed.get(1), 'HELPS');
  assert.equal(echoed.get(2), 'HELPS');
  assert.equal(echoed.get(3), 'NO');

  console.log('selftest ok');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) { selftest(); return; }

  const outDir = path.resolve(args.out);
  if (isPathInside(outDir, REPO_ROOT)) {
    console.log('refused: --out is inside the repo');
    process.exit(1);
  }
  const home = path.resolve(args.home || os.homedir());
  const projectsDir = path.resolve(args.projects || path.join(home, '.claude', 'projects'));
  fs.mkdirSync(outDir, { recursive: true });
  // A rerun into the same --out must not replay stale copies, and VACUUM INTO refuses an existing file.
  for (const sub of ['corpus', 'stores', 'global', 'judge']) fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });

  const { kept, excluded, cwds, latestTs } = collect(projectsDir, outDir);
  const stores = collectStores(home, cwds, outDir);
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    since: SINCE, collectedAt: new Date().toISOString(),
    counts: { kept: kept.length, excluded }, stores,
  }, null, 2));

  if (kept.length === 0) {
    console.log(JSON.stringify({ counts: { filesKept: 0, filesExcluded: excluded, eligible: 0 } }, null, 2));
    console.log('window short: need 30 eligible events');
    process.exit(3);
  }

  const rrRun = runReplay(outDir, home, stores);
  let rr;
  try {
    if (rrRun.status !== 0) throw new Error(`exit ${rrRun.status}`);
    rr = JSON.parse(rrRun.stdout);
  } catch {
    fs.writeFileSync(path.join(outDir, 'replay-debug.log'), `${rrRun.stdout || ''}\n${rrRun.stderr || ''}`);
    console.log(JSON.stringify({ filesKept: kept.length, excluded, replayFailed: true, status: rrRun.status ?? null }, null, 2));
    process.exit(2);
  }

  const eligible = rr.all.Z1b.addedEvents;
  const hookPrompts = rr.all.A1.tokens.hookPrompts;
  const windowHours = latestTs > -Infinity ? (latestTs - Date.parse(SINCE)) / 3600000 : 0;
  const eligiblePerDay = windowHours > 0 ? eligible / (windowHours / 24) : null;
  const counts = {
    filesKept: kept.length, filesExcluded: excluded, hookPrompts,
    nonRoutineFailures: rr.all.nonRoutineFailures, eligible, windowHours, eligiblePerDay,
    recalledCreatedWithin10MinEligible: rr.all.Z1b.recalledCreatedWithin10MinEligible,
  };
  console.log(JSON.stringify({ counts }, null, 2));

  if (eligible < MIN_EVENTS && args.dryRun === null) {
    console.log('window short: need 30 eligible events');
    process.exit(3);
  }

  const { events, eventIds, items, key } = buildJudgeSet(outDir, args.dryRun);
  const judgeCwd = path.join(outDir, 'judge', 'cwd');
  fs.mkdirSync(judgeCwd, { recursive: true });

  for (const model of ['sonnet', 'opus']) {
    if (!isolationOk(model, home, judgeCwd)) {
      console.log(`isolation check failed for ${model}`);
      process.exit(5);
    }
  }

  if (args.dryRun === null) {
    const marker = path.join(home, '.hippo-eval-locks', 'z1c-2026-09-26T23-00-00Z.json');
    if (fs.existsSync(marker)) {
      console.log('refused: marker already exists, rerun needs a committed prereg amendment');
      process.exit(4);
    }
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ collectedAt: new Date().toISOString(), out: outDir }, null, 2));
  }

  const sonnet = judge('sonnet', items, judgeCwd);
  const opus = judge('opus', items, judgeCwd);
  if (!sonnet.labels || !opus.labels) {
    if (args.dryRun === null) {
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ eligible: eventIds.length, verdict: 'VOID', reason: 'labelling incomplete after retry' }, null, 2));
    }
    console.log('VOID: judge labelling incomplete after retry');
    process.exit(6);
  }

  if (args.dryRun !== null) {
    console.log(JSON.stringify({
      dryRun: true, itemsSent: items.length,
      labelsParsed: { sonnet: sonnet.labels.size, opus: opus.labels.size },
      retries: { sonnet: sonnet.retries, opus: opus.retries },
      isolationOk: true,
    }, null, 2));
    return;
  }

  const result = score(outDir, eventIds, events, key, sonnet.labels, opus.labels, rr);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
