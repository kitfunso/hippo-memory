#!/usr/bin/env node
// Z6 automatic supersession, shipped baseline: prereg docs/evals/2026-09-28-z6-supersession-prereg.md.
// Prints AGGREGATE NUMBERS ONLY to stdout: never memory text, transcript text, user names or local paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mulberry32 } from './lib/prng.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'hippo.js');
const FIXTURE_DEFAULT = path.join(REPO, 'benchmarks', 'z6-supersession', 'fixture.json');
const OUT_DEFAULT = path.join(REPO, 'benchmarks', 'z6-supersession', 'results.json');
const EPOCH_MS = Date.parse('2026-09-01T09:00:00.000Z');
const ALL_LABELS = ['a', 'x', 'd', 'd0', 's', 'n', 'c', 'b'];
// oracle-sleep is oracle with the daily runs and interleave notes on; reported only, never part of the verdict.
const ARMS = ['capture', 'remember', 'oracle', 'oracle-sleep'];
// 06:15 UTC as an offset from day()'s 09:00 baseline.
const DAILY_RUNNER_HOURS = 6 + 15 / 60 - 9;

// ISO timestamp for day n (2026-09-01 = day 0) plus an hour offset from that day's 09:00 UTC.
function day(n, hours = 0) {
  return new Date(EPOCH_MS + n * 86400000 + hours * 3600000).toISOString();
}

function parseArgs(argv) {
  const out = { selftest: false, arms: null, only: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') out.selftest = true;
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--arms') out.arms = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--root-base') out.rootBase = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--trace') out.trace = argv[++i];
    else if (a === '--compare') out.compare = [argv[++i], argv[++i]];
  }
  return out;
}

function wilson(k, m) {
  if (!m) return [0, 0];
  const z = 1.96, p = k / m, d = 1 + (z * z) / m;
  const c = (p + (z * z) / (2 * m)) / d, w = (z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m))) / d;
  // a proportion's CI cannot leave [0,1]; clamp off the float noise a k=0 or k=m interval otherwise leaves at the edge.
  return [Math.max(0, c - w), Math.min(1, c + w)];
}

const isStr = (v) => Object.prototype.toString.call(v) === '[object String]';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, marker) => new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(marker)}($|[^\\p{L}\\p{N}_])`, 'iu').test(text);
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const sentences = (t) => t.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);

// Tune count per category/domain cell; the key order is part of the split (cell index seeds the shuffle).
const TUNE = {
  'move/personal': 3, 'move/coding': 2, 'flip/personal': 2, 'flip/coding': 3,
  'correction/personal': 3, 'correction/coding': 2, 'reversal/personal': 2, 'reversal/coding': 3,
  'control-restate/personal': 2, 'control-restate/coding': 1,
  'control-lookalike/personal': 1, 'control-lookalike/coding': 1,
};
const SPLIT_SEED = 20260928;
// The fixture's split, recomputed from its content ids: per cell, ids sorted, shuffled, first TUNE[cell] are tune.
function assignSplit(scenarios) {
  const split = new Map();
  Object.keys(TUNE).forEach((cell, ci) => {
    const ids = scenarios.filter((s) => `${s.category}/${s.domain}` === cell).map(fixtureId).sort((a, b) => a.localeCompare(b));
    const rng = mulberry32(SPLIT_SEED + ci);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    ids.forEach((id, i) => split.set(id, i < TUNE[cell] ? 'tune' : 'heldout'));
  });
  return split;
}
const CELLS = {
  move: { personal: 5, coding: 5 }, flip: { personal: 5, coding: 5 },
  correction: { personal: 5, coding: 5 }, reversal: { personal: 5, coding: 5 },
  'control-restate': { personal: 3, coding: 2 }, 'control-lookalike': { personal: 2, coding: 3 },
};
const fixtureBody = (s) => JSON.stringify({ category: s.category, domain: s.domain, statements: s.statements, question: s.question, answer: s.answer });
const fixtureId = (s) => `z6-${crypto.createHash('sha256').update(fixtureBody(s)).digest('hex').slice(0, 8)}`;
// Checker's own approximate tokenizer (R17); kept apart from the real dist/search.js one used for question reach (R8).
const simpleTokenize = (t) => t.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
const PATH_WORDS = new Set(['path', 'qa', 'qb', 'qc', 'proj']);
// One stopword list for both the checker-port and real-tokenizer content-sharing checks, so they cannot drift apart.
const STOP = new Set(('a an the and or but of to in on at for with from by as is are was were be been being am do does did done ' +
  'i we you he she it they me us him her them my our your his its their this that these those what which who whom whose where when ' +
  'how why there here now then so if not no yes can could should would will shall may might must have has had any some all just ' +
  'also still again too very about into over after before up down out off than days day moment currently right time lately ' +
  'anymore thing things one get got go going make made let lets like need want know think please thanks im its ive were youre').split(' '));
const simpleContent = (t) => new Set(simpleTokenize(t).filter((w) => !STOP.has(w)));
const simpleShares = (a, b) => { const B = simpleContent(b); return [...simpleContent(a)].some((w) => B.has(w)); };

// --- fixture validator, ported from scratchpad/z6-fixture-check.mjs ---

function fixtureProblems(fx) {
  const problems = [];
  const bad = (m) => problems.push(m);
  const counts = {};
  if (!Array.isArray(fx.background) || fx.background.length !== 60) bad(`background must have 60 notes, has ${fx.background?.length}`);
  if (!Array.isArray(fx.interleave) || fx.interleave.length !== 9) bad(`interleave must have 9 notes, has ${fx.interleave?.length}`);
  const fillers = [...(fx.background ?? []), ...(fx.interleave ?? [])].map((n) => n.text);
  if (new Set(fillers.map((t) => t.toLowerCase())).size !== fillers.length) bad('background/interleave notes must be unique');

  (fx.scenarios ?? []).forEach((s, i) => {
    const tag = `scenario[${i}] (${s.category}/${s.domain})`;
    if (!CELLS[s.category]?.[s.domain]) { bad(`${tag}: unknown category/domain`); return; }
    counts[`${s.category}/${s.domain}`] = (counts[`${s.category}/${s.domain}`] ?? 0) + 1;
    const want = s.category === 'reversal' ? 3 : 2;
    if (!Array.isArray(s.statements) || s.statements.length !== want) { bad(`${tag}: needs ${want} statements`); return; }
    const markers = s.statements.map((st) => st.marker);
    s.statements.forEach((st, k) => {
      if (!st.marker || !st.fact || !Array.isArray(st.turns) || st.turns.length < 2 || st.turns.length > 4) bad(`${tag} statement ${k}: marker, fact and 2-4 turns required`);
      if (st.turns?.[0]?.role !== 'user') bad(`${tag} statement ${k}: first turn must be the user`);
      st.turns?.forEach((t, j) => { if (t.role !== (j % 2 === 0 ? 'user' : 'assistant')) bad(`${tag} statement ${k}: turns must alternate user/assistant`); });
      if (!hasWord(st.fact, st.marker)) bad(`${tag} statement ${k}: fact lacks its marker "${st.marker}"`);
      const userText = (st.turns ?? []).filter((t) => t.role === 'user').map((t) => t.text).join('\n');
      if (!hasWord(userText, st.marker)) bad(`${tag} statement ${k}: no user turn contains marker "${st.marker}"`);
      if (/\bhippo\b|\bremember (that|this)\b|\bmemory\b/i.test((st.turns ?? []).map((t) => t.text).join('\n'))) bad(`${tag} statement ${k}: mentions hippo/memory/remember-that`);
      if (s.question && st.fact && !simpleShares(s.question, st.fact)) bad(`${tag} statement ${k}: question shares no content word with the fact`);
      const markerSentences = sentences(userText).filter((x) => hasWord(x, st.marker));
      if (s.question && markerSentences.length && !markerSentences.some((x) => simpleShares(s.question, x))) bad(`${tag} statement ${k}: question shares no content word with the user sentence holding "${st.marker}"`);
    });
    const same = s.category === 'control-restate' ? [[0, 1]] : s.category === 'reversal' ? [[0, 2]] : [];
    const differ = s.category === 'reversal' ? [[0, 1], [1, 2]] : s.category === 'control-restate' ? [] : [[0, 1]];
    for (const [a, b] of same) if (markers[a]?.toLowerCase() !== markers[b]?.toLowerCase()) bad(`${tag}: statements ${a} and ${b} must share a marker`);
    for (const [a, b] of differ) {
      if (markers[a]?.toLowerCase() === markers[b]?.toLowerCase()) bad(`${tag}: statements ${a} and ${b} need different markers`);
      if (hasWord(markers[a] ?? '', markers[b] ?? '') || hasWord(markers[b] ?? '', markers[a] ?? '')) bad(`${tag}: marker "${markers[a]}" and "${markers[b]}" overlap as whole words`);
    }
    if (!s.question || markers.some((m) => hasWord(s.question, m))) bad(`${tag}: question missing or contains a marker`);
    // remember tags every row path:qa/qb/qc/proj and BM25 indexes tags, so these words would match every remembered row.
    if (simpleTokenize(s.question ?? '').some((w) => PATH_WORDS.has(w))) bad(`${tag}: question contains a path-tag word`);
    const last = markers[markers.length - 1];
    const expected = s.category === 'control-lookalike' ? markers[0] : last;
    if (s.answer?.toLowerCase() !== expected?.toLowerCase()) bad(`${tag}: answer must be "${expected}"`);
    for (const m of new Set(markers)) for (const f of fillers) if (hasWord(f, m)) bad(`${tag}: marker "${m}" appears in a background/interleave note`);
  });
  for (const [cat, doms] of Object.entries(CELLS)) for (const [dom, n] of Object.entries(doms)) {
    if ((counts[`${cat}/${dom}`] ?? 0) !== n) bad(`cell ${cat}/${dom}: want ${n}, have ${counts[`${cat}/${dom}`] ?? 0}`);
  }
  return problems;
}

// --- child env, spawn and polling ---

function buildEnv(rootBase, fakeNow) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    // GIT_* too: a GIT_DIR or GIT_WORK_TREE would point learn --git and context --auto at a real repo.
    if (/KEY|TOKEN|SECRET/i.test(k) || k.startsWith('HIPPO_') || k.startsWith('CLAUDE') || k.startsWith('GIT_') || k === 'XDG_DATA_HOME') delete env[k];
  }
  const root = path.join(rootBase, 'qa', 'qb', 'qc');
  env.HOME = path.join(root, 'home');
  env.USERPROFILE = env.HOME;
  env.HIPPO_HOME = path.join(root, 'hh');
  env.HIPPO_SKIP_AUTO_INTEGRATIONS = '1';
  if (fakeNow) env.HIPPO_FAKE_NOW = fakeNow;
  return env;
}
const rootDirs = (rootBase) => {
  const root = path.join(rootBase, 'qa', 'qb', 'qc');
  return { root, home: path.join(root, 'home'), hh: path.join(root, 'hh'), proj: path.join(root, 'proj') };
};

// Pure predicate so the guard is selftest-able without creating any directory (R11, R18).
function rootBaseOk(rel) {
  return rel !== '' && !path.isAbsolute(rel) && !rel.startsWith('..');
}
// Outside the temp dir hippo's store walk (src/core/project-identity.ts:161-170) can reach the user's real ~/.hippo.
function checkRootBase(base) {
  fs.mkdirSync(base, { recursive: true });
  const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(base));
  if (!rootBaseOk(rel)) throw new Error(`root-base must be strictly inside the temp dir: ${base}`);
}

function runHippo(argv, cwd, env, input) {
  const r = spawnSync(process.execPath, [BIN, ...argv], { cwd, env, input, encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (r.error) throw new Error(`spawn failed: ${argv[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`hippo ${argv[0]} exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return r;
}

// Exit 0 alone proves nothing: a failed child is caught and counted, and a workspace without .hippo is skipped silently.
function dailyRunnerOk(lastLine) {
  const m = /^Daily maintenance complete: (\d+) workspaces? processed, (\d+) command failures?\.$/.exec(lastLine ?? '');
  return Boolean(m) && Number(m[1]) === 1 && Number(m[2]) === 0;
}
function runDailyRunner(proj, env) {
  const r = runHippo(['daily-runner'], proj, env);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? '';
  if (!dailyRunnerOk(last)) throw new Error(`daily-runner summary not as expected: "${last}"`);
  return r;
}

// A real blocking wait with no child process, since spawning one per 200ms poll tick is wasteful.
function blockMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pollLog(logPath, pattern, capMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) {
    const txt = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    if (pattern.test(txt)) return txt;
    blockMs(200);
  }
  throw new Error(`poll timeout waiting for session-end worker log at ${logPath}`);
}

// Pure so R18's log-shape cases run in --selftest with no spawn; the poll regex only proves the run ended, not that it ended well.
function parseWorkerLog(txt) {
  if (/skip capture: no transcript|No transcript found|had no user\/assistant messages|skip: no session_id/.test(txt)) return { ok: false, reason: 'misfed' };
  if (!txt.includes('[hippo] sleep complete') || !txt.includes('[hippo] capture complete')) return { ok: false, reason: 'incomplete' };
  const outcomeMatches = txt.match(/No actionable items found in the input\.|Captured \d+ items \(/g) ?? [];
  if (outcomeMatches.length !== 1) return { ok: false, reason: 'outcome-count' };
  if (txt.includes('No actionable items found in the input.')) return { ok: true, outcome: { type: 'no-cue' } };
  const m = /Captured (\d+) items \((\d+) skipped as duplicates(?:, (\d+) rejected)?\)/.exec(txt);
  if (!m) return { ok: false, reason: 'unrecognized' };
  return { ok: true, outcome: { type: 'captured', n: Number(m[1]), m: Number(m[2]), r: m[3] === undefined ? 0 : Number(m[3]) } };
}

// --- pre-flight (full run and --only; never selftest) ---

function probeKeysGone(env) {
  const keys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'COHERE_API_KEY', 'HIPPO_LLM_RERANKER_KEY', 'TYPESAFE_API_KEY'];
  const code = `const k=${JSON.stringify(keys)};const leaked=k.filter((n)=>process.env[n]);if(leaked.length){console.log(leaked.join(','));process.exit(1);}`;
  const r = spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (r.status !== 0) throw new Error(`paid key(s) leaked to child env: ${(r.stdout || '').trim()}`);
}

function checkNoEmbeddings() {
  let dir = path.join(REPO, 'dist');
  for (;;) {
    for (const pkg of ['@xenova/transformers', '@huggingface/transformers']) {
      if (fs.existsSync(path.join(dir, 'node_modules', pkg, 'package.json'))) throw new Error(`embedding package present: ${pkg} under ${dir}`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// --- db reads ---

let DatabaseSyncCtor = null;
async function getDatabaseSync() {
  if (!DatabaseSyncCtor) ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  return DatabaseSyncCtor;
}
function parseTags(tagsJson) {
  try { const v = JSON.parse(tagsJson ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function metaOf(metadataJson) {
  try { return JSON.parse(metadataJson); } catch { return {}; }
}
function classifyForget(metadataJson) {
  const meta = metaOf(metadataJson);
  const reason = isStr(meta.reason) ? meta.reason : '';
  if (reason.startsWith('dedup:')) return 'dedup';
  if (meta.dormant === true) return 'dormant';
  return 'other-forget';
}
function dedupSurvivorId(metadataJson) {
  const meta = metaOf(metadataJson);
  const reason = isStr(meta.reason) ? meta.reason : '';
  const m = /duplicate of (\S+)/.exec(reason);
  return m ? m[1] : null;
}

async function readBothDbs(proj, hh) {
  const DatabaseSync = await getDatabaseSync();
  const out = [];
  for (const [db, file] of [['local', path.join(proj, '.hippo', 'hippo.db')], ['global', path.join(hh, 'hippo.db')]]) {
    if (!fs.existsSync(file)) continue;
    const conn = new DatabaseSync(file, { readOnly: true });
    try {
      for (const row of conn.prepare('SELECT id, content, kind, superseded_by, confidence, tags_json, layer, source, half_life_days FROM memories').all()) {
        out.push({ id: row.id, db, content: row.content, kind: row.kind, superseded_by: row.superseded_by, confidence: row.confidence, tags: parseTags(row.tags_json), layer: row.layer, source: row.source, half_life_days: row.half_life_days });
      }
    } finally { conn.close(); }
  }
  return out;
}

// Rows of a table that may be absent from a store; any other SQL error is a real failure and is rethrown.
function tableRows(conn, sql) {
  try { return conn.prepare(sql).all(); } catch (err) {
    if (/no such table/i.test(err instanceof Error ? err.message : String(err))) return [];
    throw err;
  }
}

async function readFinalExtras(proj, hh) {
  const DatabaseSync = await getDatabaseSync();
  // dormant: id -> half-life in the snapshot sleep kept when the row went dormant.
  const conflictRows = [], forgetRows = [], dormant = new Map();
  for (const file of [path.join(proj, '.hippo', 'hippo.db'), path.join(hh, 'hippo.db')]) {
    if (!fs.existsSync(file)) continue;
    const conn = new DatabaseSync(file, { readOnly: true });
    try {
      for (const r of tableRows(conn, 'SELECT memory_a_id, memory_b_id, reason, status FROM memory_conflicts')) conflictRows.push(r);
      for (const r of tableRows(conn, "SELECT target_id, metadata_json FROM audit_log WHERE op = 'forget'")) {
        forgetRows.push({ targetId: r.target_id, cause: classifyForget(r.metadata_json), survivorId: dedupSurvivorId(r.metadata_json) });
      }
      for (const r of tableRows(conn, 'SELECT id, entry_json FROM dormant_memories')) dormant.set(r.id, metaOf(r.entry_json).half_life_days);
    } finally { conn.close(); }
  }
  return { conflictRows, forgetRows, dormant };
}

// --- transcript writer (capture arm) ---

function writeTranscript(proj, home, sid, nowIso, turns) {
  const slug = proj.replace(/[^a-zA-Z0-9]/g, '-');
  const tdir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(tdir, { recursive: true });
  const lines = [];
  let parent = null;
  turns.forEach((turn, k) => {
    const uuid = `${sid}-${k}`;
    const base = { parentUuid: parent, isSidechain: false, userType: 'external', cwd: proj, sessionId: sid, version: '2.1.0', uuid, timestamp: nowIso };
    const line = turn.role === 'user'
      ? { ...base, type: 'user', message: { role: 'user', content: turn.text } }
      : { ...base, type: 'assistant', message: { role: 'assistant', model: 'x', content: [{ type: 'text', text: turn.text }] } };
    lines.push(JSON.stringify(line));
    parent = uuid;
  });
  const file = path.join(tdir, `${sid}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// --- template build (once per run); R1-R3 ---

// The exact seven commands hook install claude-code writes (src/hooks.ts:765-879); any other command voids the run.
function checkHooks(settings) {
  const got = Object.entries(settings.hooks ?? {}).flatMap(([ev, list]) =>
    (Array.isArray(list) ? list : []).flatMap((m) => (m.hooks ?? []).map((h) => ({ ev, matcher: m.matcher ?? '', command: h.command }))));
  const one = (ev, matcher, re) => {
    const hits = got.filter((h) => h.ev === ev && h.matcher === matcher && re.test(h.command ?? ''));
    if (hits.length !== 1) throw new Error(`hook mismatch: ${ev}${matcher ? ` (${matcher})` : ''} command not as expected`);
    return re.exec(hits[0].command);
  };
  const logPath = one('SessionEnd', '', /^hippo session-end --log-file "(.+)"$/)[1];
  one('SessionStart', '', new RegExp(`^hippo last-sleep --path "${esc(logPath)}"$`));
  one('SessionStart', 'compact', /^hippo compact-resume$/);
  one('UserPromptSubmit', '', /^hippo context --pinned-only --include-recent 5 --format additional-context$/);
  const compactLog = one('PreCompact', '', /^hippo pre-compact --log-file "(.+)"$/)[1];
  one('PostCompact', '', new RegExp(`^hippo post-compact --log-file "${esc(compactLog)}"$`));
  one('PostToolUseFailure', '.*', /^hippo capture-error$/);
  if (got.length !== 7) throw new Error(`hook mismatch: ${got.length} commands installed, want 7`);
  return { logPath };
}

function buildTemplate(rootBase, fixture) {
  const qa = path.join(rootBase, 'qa');
  const tpl = path.join(rootBase, 'tpl');
  fs.rmSync(qa, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.rmSync(tpl, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const { home, hh, proj } = rootDirs(rootBase);
  for (const d of [home, hh, proj]) fs.mkdirSync(d, { recursive: true });

  // R3: learn --git must find no repo here, or the daily run reads real commit history.
  const gitCheck = spawnSync('git', ['-C', proj, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', windowsHide: true, env: buildEnv(rootBase) });
  if ((gitCheck.stdout || '').trim() === 'true') throw new Error('proj sits inside a git work tree; learn --git would read it');

  const initR = runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], proj, buildEnv(rootBase, day(-41)));
  if (!initR.stdout.includes('Initialized Hippo at') || initR.stdout.includes('Already initialized at')) throw new Error('init did not report a fresh store');
  if (!fs.existsSync(path.join(proj, '.hippo', 'hippo.db'))) throw new Error('init did not create proj/.hippo/hippo.db');
  const workspaces = JSON.parse(fs.readFileSync(path.join(hh, 'workspaces.json'), 'utf8')).workspaces;
  // hippo registers fs.realpathSync.native(root), not path.resolve; an 8.3 short name or junction would else mismatch (src/store/open.ts).
  const wantWs = fs.realpathSync.native(proj).replace(/\\/g, '/');
  const gotWs = Array.isArray(workspaces) && workspaces.length === 1 ? workspaces[0] : null;
  const wsMatch = process.platform === 'win32' ? gotWs?.toLowerCase() === wantWs.toLowerCase() : gotWs === wantWs;
  if (!wsMatch) throw new Error('hh/workspaces.json does not list exactly proj');
  runHippo(['hook', 'install', 'claude-code'], proj, buildEnv(rootBase, day(-41)));

  const { logPath } = checkHooks(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')));

  for (let d = -40; d <= 0; d++) {
    if (d > -40) runDailyRunner(proj, buildEnv(rootBase, day(d, DAILY_RUNNER_HOURS)));
    for (let i = 0; i < 60; i++) {
      if (-40 + Math.floor((i * 40) / 60) !== d) continue;
      runHippo(['remember', fixture.background[i].text], proj, buildEnv(rootBase, day(d, i / 60)));
    }
  }
  fs.cpSync(root(rootBase), tpl, { recursive: true });
  return { logPath };
}
const root = (rootBase) => rootDirs(rootBase).root;

function resetFromTemplate(rootBase) {
  const { root: r } = rootDirs(rootBase);
  const tpl = path.join(rootBase, 'tpl');
  fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.cpSync(tpl, r, { recursive: true });
}

// --- per-scenario timeline ---

function buildTimeline(scenario) {
  const K = scenario.statements.length;
  const events = [];
  for (let k = 1; k <= K; k++) {
    events.push({ day: 5 * (k - 1), type: 'statement', k });
    for (let j = 0; j < 3; j++) events.push({ day: 5 * (k - 1) + 1 + j, type: 'interleave', idx: 3 * (k - 1) + j });
  }
  events.push({ day: 5 * K, type: 'ask' });
  return events.sort((a, b) => a.day - b.day);
}

function runCaptureStatement(scenario, k, stmt, proj, env, logPath) {
  runHippo(['last-sleep', '--path', logPath], proj, env);
  if (fs.existsSync(logPath)) throw new Error(`last-sleep did not clear the log before statement ${k} of ${scenario.id}`);
  const sid = `${scenario.id}-capture-s${k}`;
  const transcriptPath = writeTranscript(proj, env.HOME, sid, env.HIPPO_FAKE_NOW, stmt.turns);
  const payload = JSON.stringify({ session_id: sid, transcript_path: transcriptPath, cwd: proj, hook_event_name: 'SessionEnd', reason: 'exit' });
  runHippo(['session-end', '--log-file', logPath], proj, env, payload);
  const txt = pollLog(logPath, /closed \d+ active snapshot\(s\) for session|skip: no session_id|snapshot close failed/, 60000);
  const parsed = parseWorkerLog(txt);
  if (!parsed.ok) throw new Error(`worker log ${parsed.reason} at ${sid}`);
  return parsed.outcome;
}

function runStatementEvent(scenario, k, arm, proj, rootBase, logPath, oracleIds) {
  const stmt = scenario.statements[k - 1];
  const t = day(5 * (k - 1));
  const env = buildEnv(rootBase, t);
  if (arm === 'capture') return runCaptureStatement(scenario, k, stmt, proj, env, logPath);
  if (arm === 'remember') { runHippo(['remember', stmt.fact], proj, env); return null; }
  if (k === 1) {
    const r = runHippo(['remember', stmt.fact], proj, env);
    const m = /Remembered \[(\S+)\]/.exec(r.stdout);
    if (!m) throw new Error('oracle: remember did not report an id');
    oracleIds.push(m[1]);
  } else {
    const prev = oracleIds[oracleIds.length - 1];
    const r = runHippo(['supersede', prev, stmt.fact], proj, env);
    const m = /Superseded (\S+) \S+ (\S+)/.exec(r.stdout);
    if (!m) throw new Error('oracle: supersede did not report a new id');
    oracleIds.push(m[2]);
  }
  return null;
}

// --- recall output parsing ---

// matchAll (not match) so every "--- id [" line counts; match() alone silently keeps only the first (R19).
function parseRankedIds(stdout) {
  return [...stdout.matchAll(/^--- (\S+) \[/gm)].map((m) => m[1]);
}

// --- explain parsing ---

function parseExplainBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[(\d+)\] (\S+)\s/.exec(line);
    if (m) { if (cur) blocks.push(cur); cur = { id: m[2], lines: [line] }; continue; }
    if (line.startsWith('Note:')) { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ id: b.id, text: b.lines.join('\n') }));
}
function assertBm25Only(blocks) {
  for (const b of blocks) {
    const m = /^\s*mode:\s+(\S+)/m.exec(b.text);
    if (!m || m[1] !== 'bm25-only') throw new Error(`explain block ${b.id} mode is not bm25-only`);
  }
}

// --- row value attribution ---

function keysContainedIn(content, statements) {
  const out = new Set();
  statements.forEach((s) => { if (hasWord(content, s.marker)) out.add(norm(s.marker)); });
  return out;
}

function computeValues(orderedRows, statements) {
  const earlierLocalAll = [], earlierLocalNonDerived = [];
  for (const row of orderedRows) {
    const isDerived = row.content.startsWith('[Consolidated');
    if (isDerived) {
      // Linked on the sources found, not on their values, so a derived copy of an echo row stays valueless.
      const sources = earlierLocalNonDerived.filter((r) => norm(row.content).includes(norm(r.content).slice(0, 60)));
      row.values = sources.length ? new Set(sources.flatMap((r) => [...r.values])) : keysContainedIn(row.content, statements);
      row.flags = sources.length ? [] : ['unlinked'];
    } else if (row.db === 'global') {
      const match = earlierLocalAll.find((r) => norm(r.content) === norm(row.content));
      row.values = match ? new Set(match.values) : keysContainedIn(row.content, statements);
      row.flags = match ? [] : ['unlinked'];
    } else if (row.firstSeen.stmtK) {
      const k = row.firstSeen.stmtK;
      if (hasWord(row.content, statements[k - 1].marker)) { row.values = new Set([norm(statements[k - 1].marker)]); row.flags = []; }
      else {
        // An echo names another statement's value ("we moved out of X") without its own, so it carries none.
        const others = statements.map((_, i) => i + 1).filter((k2) => k2 !== k && hasWord(row.content, statements[k2 - 1].marker));
        row.values = new Set();
        row.flags = others.length ? ['echo'] : [];
      }
    } else {
      row.values = new Set();
      row.flags = [];
    }
    if (row.db === 'local') { earlierLocalAll.push(row); if (!isDerived) earlierLocalNonDerived.push(row); }
  }
}

const isRetired = (r) => Boolean(r.superseded_by) || r.kind === 'superseded' || r.tags.includes('invalidated') || r.tags.includes('superseded') || r.confidence === 'stale';

function captured(step, marker, rows) {
  for (const r of rows.values()) if (r.db === 'local' && !r.content.startsWith('[Consolidated') && r.firstSeen.stmtK === step && hasWord(r.content, marker)) return true;
  return false;
}
function capturedAny(pairs, rows) { return pairs.some(([step, marker]) => captured(step, marker, rows)); }

// Reason a value was never captured; only the capture arm's outcome counts distinguish the three failure shapes.
function missingReason(step, arm, captureOutcomes) {
  if (arm !== 'capture') return 'not-stored';
  const rec = captureOutcomes.find((c) => c.k === step);
  const outcome = rec ? rec.outcome : null;
  if (!outcome || outcome.type === 'no-cue') return 'no-cue';
  if (outcome.n === 0 && outcome.m > 0) return 'dup';
  if (outcome.n === 0 && outcome.m === 0 && outcome.r > 0) return 'rejected';
  return 'no-marker';
}
// Cause a carrier vanished by final snapshot; detail keeps counts only, never the ids themselves.
// merge-fade: in this run only a merge cuts a half-life (src/consolidate.ts:912); invalidate, resolve and decide never run.
function vanishedCause(row, forgetRows, dormant) {
  const forget = forgetRows.find((f) => f.targetId === row.id);
  const cause = forget ? forget.cause : dormant.has(row.id) ? 'dormant' : 'unrecorded';
  return cause === 'dormant' && dormant.get(row.id) < row.firstHalfLife ? 'merge-fade' : cause;
}
const emptyCauses = () => ({ dedup: 0, dormant: 0, 'merge-fade': 0, 'other-forget': 0, unrecorded: 0 });
function causeCounts(lostRows, forgetRows, dormant) {
  const counts = emptyCauses();
  for (const r of lostRows) counts[vanishedCause(r, forgetRows, dormant)]++;
  return counts;
}
// Every label records its lost S and C carriers; dedupDeletions alone misses a delete whose survivor was never snapshotted.
function carriersLost(sRows, cRows, finalIds, forgetRows, dormant) {
  const lost = (list) => causeCounts(list.filter((r) => !finalIds.has(r.id)), forgetRows, dormant);
  return { old: lost(sRows), new: lost(cRows) };
}
const addCauses = (list) => list.reduce((acc, c) => { for (const [k, v] of Object.entries(c ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
// R16: recorded in every arm so an n/s label can be told apart from a question that never reached a stored clause.
function computeReach(blocks, sIds, cIds) {
  return blocks.some((b) => sIds.has(b.id)) && blocks.some((b) => cIds.has(b.id));
}

// Follows superseded_by from startRow; true once a hop lands on a row that satisfies ok.
function chainReaches(startRow, rows, ok) {
  const seen = new Set();
  let cur = startRow;
  while (cur && cur.superseded_by && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = rows.get(cur.superseded_by);
    if (cur && ok(cur)) return true;
  }
  return false;
}
function isLinked(r, rows, finalIds, blocks, cCarrierIds, cMarker, cKey) {
  if (chainReaches(r, rows, (n) => finalIds.has(n.id) && n.values.has(cKey))) return true;
  const b = blocks.find((x) => x.id === r.id);
  if (!b) return false;
  return /supersed|invalidat|retired|replaced/i.test(b.text) && (cCarrierIds.some((id) => b.text.includes(id)) || hasWord(b.text, cMarker));
}
function reasonTest(blocks, sCarrierIds, cCarrierIds, sMarker, cMarker) {
  const pat = /supersed|invalidat|retired|replaced/i;
  const blockOf = (id) => blocks.find((b) => b.id === id);
  const sHit = sCarrierIds.some((id) => { const b = blockOf(id); return b && pat.test(b.text) && (cCarrierIds.some((cid) => b.text.includes(cid)) || hasWord(b.text, cMarker)); });
  if (sHit) return true;
  return cCarrierIds.some((id) => { const b = blockOf(id); return b && pat.test(b.text) && (sCarrierIds.some((sid) => b.text.includes(sid)) || hasWord(b.text, sMarker)); });
}

function contextShows(row, contextText) {
  if (!contextText) return false;
  return new RegExp('(?:\\): |\\] |\\uFE0F )' + esc(row.content) + '\\*\\*').test(contextText);
}

// Union label by default; turning surfaces off (e.g. {context:false, auto:false}) gives a per-surface label.
function labelChange(rows, finalIds, statements, contextText, rankedIds, blocks, surfaces = {}, ctx = {}) {
  const { arm = 'capture', captureOutcomes = [], forgetRows = [], dormant = new Map(), autoText = '' } = ctx;
  const K = statements.length;
  const sStep = K - 1, sMarker = statements[K - 2].marker, sKey = norm(sMarker);
  const cStep = K, cMarker = statements[K - 1].marker, cKey = norm(cMarker);
  if (!captured(sStep, sMarker, rows) || !captured(cStep, cMarker, rows)) {
    const missing = !captured(sStep, sMarker, rows) && !captured(cStep, cMarker, rows) ? 'both' : !captured(sStep, sMarker, rows) ? 'old' : 'new';
    const reasons = {};
    if (missing !== 'new') reasons.old = missingReason(sStep, arm, captureOutcomes);
    if (missing !== 'old') reasons.new = missingReason(cStep, arm, captureOutcomes);
    return { label: 'a', detail: { missing, reasons } };
  }
  const carriersOf = (key) => [...rows.values()].filter((r) => r.values.has(key));
  const sCarriers = carriersOf(sKey), cCarriers = carriersOf(cKey);
  const presentS = sCarriers.filter((r) => finalIds.has(r.id));
  const presentC = cCarriers.filter((r) => finalIds.has(r.id));
  if (!presentS.length || !presentC.length) {
    const vanished = !presentS.length && !presentC.length ? 'both' : !presentS.length ? 'old' : 'new';
    const causes = {};
    if (vanished !== 'new') causes.old = causeCounts(sCarriers.filter((r) => !finalIds.has(r.id)), forgetRows, dormant);
    if (vanished !== 'old') causes.new = causeCounts(cCarriers.filter((r) => !finalIds.has(r.id)), forgetRows, dormant);
    return { label: 'x', detail: { vanished, causes } };
  }
  const activeS = presentS.filter((r) => !isRetired(r));
  const ctxOk = surfaces.context !== false, recOk = surfaces.recall !== false, autoOk = surfaces.auto !== false;
  const showsCtx = (r) => ctxOk && contextShows(r, contextText);
  const showsRec = (r) => recOk && rankedIds.includes(r.id);
  const showsAuto = (r) => autoOk && contextShows(r, autoText);
  const rankOf = (r) => rankedIds.indexOf(r.id);
  const bestRank = (carriers) => carriers.filter(showsRec).reduce((m, r) => Math.min(m, rankOf(r)), Infinity);
  const sShownCtx = presentS.some(showsCtx), cShownCtx = presentC.some(showsCtx);
  const sShownRec = presentS.some(showsRec), cShownRec = presentC.some(showsRec);
  const sShownAuto = presentS.some(showsAuto), cShownAuto = presentC.some(showsAuto);
  const sShownAny = sShownCtx || sShownRec || sShownAuto, cShownAny = cShownCtx || cShownRec || cShownAuto;
  // Only superseded_by hides a row (src/api/index.ts:2591, 863); a stale or tagged S still shows, and this counts it.
  const retiredS = presentS.filter(isRetired);
  const shown = { sRetired: retiredS.length, sRetiredShown: retiredS.filter((r) => showsCtx(r) || showsRec(r) || showsAuto(r)).length };

  if (!activeS.length && cShownAny && !sShownAny) {
    const reasonOk = reasonTest(blocks, presentS.map((r) => r.id), presentC.map((r) => r.id), sMarker, cMarker);
    const linked = retiredS.map((r) => isLinked(r, rows, finalIds, blocks, presentC.map((x) => x.id), cMarker, cKey));
    const unlinkedRetired = linked.filter((v) => !v).length;
    // A link whose chain ends at a vanished row: the retirement named a successor that sleep later removed.
    const danglingLinks = retiredS.filter((r) => r.superseded_by && !chainReaches(r, rows, (n) => finalIds.has(n.id))).length;
    const pass = reasonOk && unlinkedRetired === 0;
    return { label: pass ? 'd' : 'd0', detail: { reasonOk, unlinkedRetired, danglingLinks, ...shown } };
  }
  if (sShownAny && !cShownAny) return { label: 's', detail: shown };
  if (!sShownAny && !cShownAny) return { label: 'n', detail: shown };
  const winsCtx = cShownCtx && !sShownCtx;
  const winsRec = cShownRec && (!sShownRec || bestRank(presentC) < bestRank(presentS));
  const winsAuto = cShownAuto && !sShownAuto;
  const winsEverywhereSShown = (!sShownCtx || winsCtx) && (!sShownRec || winsRec) && (!sShownAuto || winsAuto);
  if (cShownAny && winsEverywhereSShown) return { label: 'c', detail: shown };
  return { label: 'b', detail: shown };
}

function controlValues(statements) {
  const map = new Map();
  statements.forEach((s, i) => {
    const key = norm(s.marker);
    const list = map.get(key) ?? [];
    list.push([i + 1, s.marker]);
    map.set(key, list);
  });
  return map;
}
// pass needs every statement stored (a restatement skipped as a duplicate of its twin counts); a seen failure fails regardless.
function labelControl(statements, rows, finalIds, conflictRows, ctx = {}) {
  const { arm = 'capture', captureOutcomes = [] } = ctx;
  const values = controlValues(statements);
  const restated = (k) => statements.slice(0, k - 1).some((s) => norm(s.marker) === norm(statements[k - 1].marker));
  const stored = (k) => captured(k, statements[k - 1].marker, rows) || (restated(k) && missingReason(k, arm, captureOutcomes) === 'dup');
  const evaluable = statements.every((_, i) => stored(i + 1));
  let failRetired = false, failLost = false;
  const carrierIds = new Set();
  for (const [key, pairs] of values) {
    const present = [...rows.values()].filter((r) => r.values.has(key) && finalIds.has(r.id));
    present.forEach((r) => carrierIds.add(r.id));
    // A restatement retired in favour of its own newer copy keeps the value active, so that alone is no failure.
    const activeSameValue = (n) => finalIds.has(n.id) && n.values.has(key) && !isRetired(n);
    if (present.some((r) => isRetired(r) && !chainReaches(r, rows, activeSameValue))) failRetired = true;
    if (capturedAny(pairs, rows) && !present.length) failLost = true;
  }
  const falseConflictRows = conflictRows.filter((c) => c.status === 'open' && carrierIds.has(c.memory_a_id) && carrierIds.has(c.memory_b_id)).length;
  const label = failRetired || failLost ? 'fail' : evaluable ? 'pass' : 'n/a';
  return { label, evaluable, failRetired, failLost, falseConflictRows };
}

// R15: a filler row the run ever wrote must survive untouched; retired or vanished both count against PASS.
function fillerCounts(rows, finalIds, fillerNormSet, forgetRows = [], dormant = new Map()) {
  let fillerRetired = 0, fillerActive = 0;
  const fillerLost = emptyCauses();
  for (const r of rows.values()) {
    if (!fillerNormSet.has(norm(r.content))) continue;
    if (finalIds.has(r.id)) { if (isRetired(r)) fillerRetired++; else fillerActive++; continue; }
    fillerLost[vanishedCause(r, forgetRows, dormant)]++;
  }
  return { fillerRetired, fillerActive, fillerLost };
}
const fillerLostTotal = (fl) => Object.values(fl ?? {}).reduce((a, b) => a + b, 0);

function changeDiagnostics(rows, finalIds, sKey, cKey, conflictRows, forgetRows) {
  const sIds = new Set([...rows.values()].filter((r) => r.values.has(sKey)).map((r) => r.id));
  const cIds = new Set([...rows.values()].filter((r) => r.values.has(cKey)).map((r) => r.id));
  const conflictSC = conflictRows.filter((c) => (sIds.has(c.memory_a_id) && cIds.has(c.memory_b_id)) || (sIds.has(c.memory_b_id) && cIds.has(c.memory_a_id))).length;
  // A derived row carries the values of the members whose text it quotes, so these say which text a merge kept.
  const derived = [...rows.values()].filter((r) => finalIds.has(r.id) && r.db === 'local' && r.content.startsWith('[Consolidated'));
  const derivedS = derived.filter((r) => r.values.has(sKey) && !r.values.has(cKey)).length;
  const derivedC = derived.filter((r) => r.values.has(cKey) && !r.values.has(sKey)).length;
  const derivedBoth = derived.filter((r) => r.values.has(sKey) && r.values.has(cKey)).length;
  const echo = [...rows.values()].filter((r) => (r.flags ?? []).includes('echo')).length;
  const dedupDeletions = [];
  for (const f of forgetRows) {
    if (f.cause !== 'dedup' || !f.survivorId) continue;
    const removed = rows.get(f.targetId);
    if (!removed || !(sIds.has(f.targetId) || cIds.has(f.targetId))) continue;
    const kept = rows.get(f.survivorId);
    if (!kept) continue;
    const age = kept.firstSeen.step === removed.firstSeen.step ? 'same-step' : kept.firstSeen.step < removed.firstSeen.step ? 'older' : 'newer';
    const keys = [sKey, cKey];
    const value = keys.some((k) => removed.values.has(k) && kept.values.has(k)) ? 'same' : keys.some((k) => kept.values.has(k)) ? 'other' : 'none';
    dedupDeletions.push({ kept: age, value });
  }
  return { conflictSC, derivedS, derivedC, derivedBoth, echo, dedupDeletions };
}

// --- one (scenario, arm) run ---

async function runScenarioArm(scenario, arm, rootBase, tplInfo, fixture, fillerNormSet, traceFile) {
  resetFromTemplate(rootBase);
  const { hh, proj } = rootDirs(rootBase);
  const rows = new Map();
  let stepCounter = 0;
  async function snap(stmtK) {
    stepCounter++;
    const rowsNow = await readBothDbs(proj, hh);
    for (const r of rowsNow) {
      const existing = rows.get(r.id);
      if (existing) Object.assign(existing, r, { firstSeen: existing.firstSeen });
      else rows.set(r.id, { ...r, firstSeen: { step: stepCounter, stmtK: stmtK ?? null }, firstHalfLife: r.half_life_days });
    }
    return new Set(rowsNow.map((r) => r.id));
  }

  const K = scenario.statements.length;
  const isChange = !scenario.category.startsWith('control');
  const events = buildTimeline(scenario);
  const oracleIds = [];
  const captureOutcomes = [];
  let cursor = 0;
  const askDay = 5 * K;
  // Baseline: a template row that statement 1's own sleep deletes must still be seen, or it escapes the filler guard.
  await snap(null);
  for (let d = 0; d <= askDay; d++) {
    if (d > 0 && arm !== 'oracle') runDailyRunner(proj, buildEnv(rootBase, day(d, DAILY_RUNNER_HOURS)));
    if (d > 0 && arm !== 'oracle') await snap(null);
    while (cursor < events.length && events[cursor].day === d) {
      const ev = events[cursor++];
      if (ev.type === 'statement') {
        const outcome = runStatementEvent(scenario, ev.k, arm, proj, rootBase, tplInfo.logPath, oracleIds);
        if (outcome) captureOutcomes.push({ k: ev.k, outcome });
        await snap(ev.k);
      } else if (ev.type === 'interleave' && arm !== 'oracle') {
        runHippo(['remember', fixture.interleave[ev.idx].text], proj, buildEnv(rootBase, day(d)));
        await snap(null);
      }
    }
  }

  const t = day(askDay);
  const env = buildEnv(rootBase, t);
  const askSid = `ask-${scenario.id}-${arm}`;
  const ctxPayload = JSON.stringify({ session_id: askSid, prompt: scenario.question, cwd: proj, hook_event_name: 'UserPromptSubmit' });
  const ctxR = runHippo(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'], proj, env, ctxPayload);
  const contextText = ctxR.stdout.trim() ? JSON.parse(ctxR.stdout).hookSpecificOutput.additionalContext : '';
  // The command the CLAUDE.md block hippo writes tells the agent to run at task start (src/cli.ts:7819).
  const autoText = runHippo(['context', '--auto', '--budget', '1500'], proj, env).stdout;
  const recallR = runHippo(['recall', scenario.question], proj, env);
  const rankedIds = parseRankedIds(recallR.stdout);
  const explainR = runHippo(['explain', scenario.question, '--include-superseded'], proj, env);
  const blocks = parseExplainBlocks(explainR.stdout);
  assertBm25Only(blocks);
  const finalIds = await snap(null);
  const extras = await readFinalExtras(proj, hh);

  const orderedRows = [...rows.values()].sort((a, b) => a.firstSeen.step - b.firstSeen.step);
  computeValues(orderedRows, scenario.statements);
  const filler = fillerCounts(rows, finalIds, fillerNormSet, extras.forgetRows, extras.dormant);

  let label, detail, contextLabel, recallLabel, autoLabel;
  if (isChange) {
    const labelCtx = { arm, captureOutcomes, forgetRows: extras.forgetRows, dormant: extras.dormant, autoText };
    const labelOn = (surfaces) => labelChange(rows, finalIds, scenario.statements, contextText, rankedIds, blocks, surfaces, labelCtx);
    const union = labelOn({});
    label = union.label;
    const sKey = norm(scenario.statements[K - 2].marker), cKey = norm(scenario.statements[K - 1].marker);
    const diag = changeDiagnostics(rows, finalIds, sKey, cKey, extras.conflictRows, extras.forgetRows);
    // R16: recorded for every arm, not just oracle, so an n/s label can be told apart from a question that never reached a stored clause.
    const sRows = [...rows.values()].filter((r) => r.values.has(sKey));
    const cRows = [...rows.values()].filter((r) => r.values.has(cKey));
    const reach = computeReach(blocks, new Set(sRows.map((r) => r.id)), new Set(cRows.map((r) => r.id)));
    const lost = carriersLost(sRows, cRows, finalIds, extras.forgetRows, extras.dormant);
    detail = { ...union.detail, ...diag, ...filler, carriersLost: lost, reach, captureOutcomes: arm === 'capture' ? captureOutcomes.map((c) => ({ k: c.k, outcome: c.outcome })) : undefined };
    contextLabel = labelOn({ recall: false, auto: false }).label;
    recallLabel = labelOn({ context: false, auto: false }).label;
    autoLabel = labelOn({ context: false, recall: false }).label;
  } else {
    const ctrl = labelControl(scenario.statements, rows, finalIds, extras.conflictRows, { arm, captureOutcomes });
    label = ctrl.label;
    detail = { ...ctrl, ...filler, captureOutcomes: arm === 'capture' ? captureOutcomes.map((c) => ({ k: c.k, outcome: c.outcome })) : undefined };
    contextLabel = recallLabel = autoLabel = label;
  }

  if (traceFile) {
    const traceRows = orderedRows.map((r) => ({
      id: r.id, db: r.db, content: r.content, values: [...r.values], firstSeen: r.firstSeen,
      retired: isRetired(r), present: finalIds.has(r.id), shownContext: contextShows(r, contextText), shownRecall: rankedIds.includes(r.id), shownAuto: contextShows(r, autoText),
    }));
    fs.appendFileSync(traceFile, JSON.stringify({ scenarioId: scenario.id, arm, rows: traceRows, captureOutcomes }) + '\n');
  }

  return { id: scenario.id, split: scenario.split, category: scenario.category, domain: scenario.domain, arm, label, contextLabel, recallLabel, autoLabel, detail };
}

// --- summary and verdict ---

function buildSummary(results) {
  const arms = [...new Set(results.map((r) => r.arm))];
  const splits = ['tune', 'heldout', 'all'];
  const summary = {};
  for (const arm of arms) {
    summary[arm] = {};
    for (const split of splits) {
      const rows = results.filter((r) => r.arm === arm && (split === 'all' || r.split === split));
      const change = rows.filter((r) => !r.category.startsWith('control'));
      const controls = rows.filter((r) => r.category.startsWith('control'));
      const counts = Object.fromEntries(ALL_LABELS.map((l) => [l, change.filter((r) => r.label === l).length]));
      const byCategory = {}, byDomain = {};
      for (const r of change) {
        byCategory[r.category] = byCategory[r.category] ?? Object.fromEntries(ALL_LABELS.map((l) => [l, 0]));
        byCategory[r.category][r.label]++;
        byDomain[r.domain] = byDomain[r.domain] ?? Object.fromEntries(ALL_LABELS.map((l) => [l, 0]));
        byDomain[r.domain][r.label]++;
      }
      const perSurface = Object.fromEntries(['context', 'recall', 'auto'].map((sf) => [sf, Object.fromEntries(ALL_LABELS.map((l) => [l, change.filter((r) => r[`${sf}Label`] === l).length]))]));
      const pass = counts.d ?? 0;
      // The build's second rate: d among scenarios where both S and C were stored, so capture misses do not hide it.
      const storedBoth = change.filter((r) => r.label !== 'a').length;
      const sumOf = (key) => change.reduce((s, r) => s + (r.detail[key] ?? 0), 0);
      summary[arm][split] = {
        counts, byCategory, byDomain, perSurface,
        pass, total: change.length, wilson: wilson(pass, change.length),
        storedBoth, passAmongStored: { pass, of: storedBoth, wilson: wilson(pass, storedBoth) },
        controls: {
          total: controls.length, evaluable: controls.filter((r) => r.detail.evaluable).length,
          pass: controls.filter((r) => r.label === 'pass').length, fail: controls.filter((r) => r.label === 'fail').length, na: controls.filter((r) => r.label === 'n/a').length,
          failRetired: controls.filter((r) => r.detail.failRetired).length, failLost: controls.filter((r) => r.detail.failLost).length,
          falseConflictRows: controls.reduce((s, r) => s + (r.detail.falseConflictRows ?? 0), 0),
        },
        diagnostics: {
          conflictSC: sumOf('conflictSC'),
          derivedS: sumOf('derivedS'), derivedC: sumOf('derivedC'), derivedBoth: sumOf('derivedBoth'),
          echo: sumOf('echo'), danglingLinks: sumOf('danglingLinks'), sRetired: sumOf('sRetired'), sRetiredShown: sumOf('sRetiredShown'),
          fillerRetired: rows.reduce((s, r) => s + (r.detail.fillerRetired ?? 0), 0),
          fillerActive: rows.reduce((s, r) => s + (r.detail.fillerActive ?? 0), 0),
          fillerLost: rows.reduce((s, r) => s + fillerLostTotal(r.detail.fillerLost), 0),
          fillerLostByCause: addCauses(rows.map((r) => r.detail.fillerLost)),
          carriersLostOld: addCauses(change.map((r) => r.detail.carriersLost?.old)),
          carriersLostNew: addCauses(change.map((r) => r.detail.carriersLost?.new)),
          reach: change.reduce((s, r) => s + (r.detail.reach ? 1 : 0), 0),
        },
      };
    }
  }
  return summary;
}

function computeVerdict(results, runArgs) {
  if (runArgs.only || (runArgs.arms && !ARMS.every((a) => runArgs.arms.includes(a)))) return { status: 'PARTIAL', reasons: [] };
  const oracleRows = results.filter((r) => r.arm === 'oracle');
  if (oracleRows.length === 40) {
    const successes = oracleRows.filter((r) => (r.label === 'd' || r.label === 'd0') && r.detail.reach).length;
    if (successes < 36) return { status: 'VOID', reasons: [`oracle reach ${successes}/40 < 36`] };
  }
  const heldoutCapture = results.filter((r) => r.arm === 'capture' && r.split === 'heldout');
  const heldoutChange = heldoutCapture.filter((r) => !r.category.startsWith('control'));
  const heldoutControl = heldoutCapture.filter((r) => r.category.startsWith('control'));
  const dCount = heldoutChange.filter((r) => r.label === 'd').length;
  const controlFail = heldoutControl.filter((r) => r.label === 'fail').length;
  const controlPass = heldoutControl.filter((r) => r.label === 'pass').length;
  const fillerSum = heldoutCapture.reduce((s, r) => s + (r.detail.fillerRetired ?? 0) + fillerLostTotal(r.detail.fillerLost), 0);
  const reasons = [];
  if (dCount < 18) reasons.push(`capture d on ${dCount}/20 held-out change scenarios`);
  if (controlFail > 0) reasons.push(`${controlFail} held-out capture-arm control(s) failed`);
  if (controlPass < 4) reasons.push(`held-out capture-arm controls passed ${controlPass}/5, need 4`);
  if (fillerSum > 0) reasons.push(`${fillerSum} filler row(s) retired or lost across held-out capture scenarios`);
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons };
}

function printStdout(results, verdict) {
  const arms = [...new Set(results.map((r) => r.arm))];
  for (const arm of arms) {
    for (const split of ['tune', 'heldout']) {
      const rows = results.filter((r) => r.arm === arm && r.split === split && !r.category.startsWith('control'));
      if (!rows.length) continue;
      const counts = ALL_LABELS.map((l) => `${l}=${rows.filter((r) => r.label === l).length}`).join(' ');
      const d = rows.filter((r) => r.label === 'd').length;
      const [lo, hi] = wilson(d, rows.length);
      console.log(`${arm}/${split}: ${counts} | pass ${d}/${rows.length} [${lo.toFixed(3)},${hi.toFixed(3)}]`);
    }
    const controls = results.filter((r) => r.arm === arm && r.category.startsWith('control'));
    const nOf = (l) => controls.filter((r) => r.label === l).length;
    if (controls.length) console.log(`${arm}/controls: pass ${nOf('pass')} fail ${nOf('fail')} n/a ${nOf('n/a')} of ${controls.length}`);
  }
  console.log(`verdict: ${verdict.status}${verdict.reasons.length ? ' (' + verdict.reasons.join('; ') + ')' : ''}`);
}

// --- compare mode ---

function compareResults(a, b) {
  console.log(`a verdict: ${a.verdict.status}`);
  console.log(`b verdict: ${b.verdict.status}`);
  console.log(`verdicts match: ${a.verdict.status === b.verdict.status}`);
  const arms = [...new Set([...a.scenarios.map((s) => s.arm), ...b.scenarios.map((s) => s.arm)])];
  for (const arm of arms) {
    const am = new Map(a.scenarios.filter((s) => s.arm === arm).map((s) => [s.id, s.label]));
    const bm = new Map(b.scenarios.filter((s) => s.arm === arm).map((s) => [s.id, s.label]));
    let diff = 0;
    for (const [id, label] of am) if (bm.has(id) && bm.get(id) !== label) diff++;
    console.log(`${arm}: ${diff} scenario(s) with a different label`);
  }
}

// --- selftest ---

function selftestFixtureContract(fx, check) {
  const problems = fixtureProblems(fx);
  check(problems.length === 0, `fixture shape: ${problems.slice(0, 5).join(' | ')}`);
  const ids = new Set();
  const split = assignSplit(fx.scenarios);
  for (const s of fx.scenarios) {
    check(s.id === fixtureId(s), `scenario id matches its content hash (${s.id})`);
    check(!ids.has(s.id), `scenario id unique (${s.id})`);
    ids.add(s.id);
    check(s.split === split.get(s.id), `scenario split matches the recomputed split (${s.id})`);
  }
  const cellTune = {};
  for (const s of fx.scenarios) {
    const cell = `${s.category}/${s.domain}`;
    if (s.split === 'tune') cellTune[cell] = (cellTune[cell] ?? 0) + 1;
  }
  for (const [cell, want] of Object.entries(TUNE)) check((cellTune[cell] ?? 0) === want, `cell ${cell} tune count is ${want}`);
  const change = fx.scenarios.filter((s) => !s.category.startsWith('control'));
  const control = fx.scenarios.filter((s) => s.category.startsWith('control'));
  check(change.filter((s) => s.split === 'tune').length === 20 && control.filter((s) => s.split === 'tune').length === 5, 'tune totals are 20 change + 5 control');
  check(change.filter((s) => s.split === 'heldout').length === 20 && control.filter((s) => s.split === 'heldout').length === 5, 'heldout totals are 20 change + 5 control');
}

async function selftestQuestionReach(fx, check) {
  const search = await import(pathToFileURL(path.join(REPO, 'dist', 'util/tokenize.js')).href);
  const tokenize = search.tokenize;
  const content = (t) => new Set(tokenize(t).filter((w) => !STOP.has(w)));
  const shares = (a, b) => { const B = content(b); return [...content(a)].some((w) => B.has(w)); };
  // N/50 counts scenarios, not statement pairs: a scenario counts once, only if every one of its statements reaches.
  let hit = 0;
  for (const s of fx.scenarios) {
    const ok = s.statements.every((st) => {
      const factOk = shares(s.question, st.fact);
      const markerSentences = sentences((st.turns ?? []).filter((t) => t.role === 'user').map((t) => t.text).join('\n')).filter((x) => hasWord(x, st.marker));
      const sentOk = !markerSentences.length || markerSentences.some((x) => shares(s.question, x));
      return factOk && sentOk;
    });
    if (ok) hit++;
  }
  console.log(`question reach: ${hit}/${fx.scenarios.length}`);
  check(hit === fx.scenarios.length, `question reach ${hit}/${fx.scenarios.length}`);
}

function selftestLabeller(check) {
  // synthetic row helper: minimal RowMeta plus pre-set values/flags for direct label-function tests
  const row = (id, db, content, step, stmtK, extra = {}) => ({ id, db, content, superseded_by: null, kind: 'episodic', confidence: 'observed', tags: [], layer: 'episodic', source: 'cli', firstSeen: { step, stmtK }, ...extra });
  // The line shape printContextMarkdown writes for an observed row, so label tests exercise the real context regex.
  const ctxLine = (content) => `- **[observed] Previously observed (2026-01-01): ${content}**`;
  const throwsHook = (fn) => { try { fn(); return false; } catch (err) { return /hook mismatch/.test(err.message); } };
  const stmts2 = [{ marker: 'Mumbai' }, { marker: 'Delhi' }].map((s, i) => ({ marker: i === 0 ? 'Mumbai' : 'Delhi' }));
  // S = statements[0] (Mumbai), C = statements[1] (Delhi) for these synthetic checks (K=2).
  const h = { row, ctxLine, throwsHook, stmts2 };
  selftestLabelCases(check, h);
  selftestAttribution(check, h);
  selftestParsers(check, h);
  selftestControl(check, h);
  selftestVerdict(check);
  selftestRetirementLinks(check, h);
  selftestDiagnostics(check, h);
  selftestWorkerAndGuards(check, h);
  selftestLossCauses(check, h);
}

function selftestLabelCases(check, h) {
  const { row, ctxLine, stmts2 } = h;
  // a: neither statement captured.
  { const rows = new Map(); computeValues([], stmts2);
    const r = labelChange(rows, new Set(), stmts2, '', [], []);
    check(r.label === 'a', 'labelChange: a when nothing captured'); }

  // x: captured but not present at ask time.
  { const rows = new Map([['s1', row('s1', 'local', 'moved to Mumbai', 1, 1)], ['c1', row('c1', 'local', 'now in Delhi', 2, 2)]]);
    computeValues([...rows.values()], stmts2);
    const r = labelChange(rows, new Set(), stmts2, '', [], []);
    check(r.label === 'x', 'labelChange: x when captured rows are gone by the ask'); }

  // d: S retired with a reason that links to C, C shown, S shown nowhere.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1, { superseded_by: 'c1' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const finalIds = new Set(['s1', 'c1']);
    const blocks = [{ id: 's1', text: '[1] s1 composite=0.1\nsuperseded by c1' }, { id: 'c1', text: '[2] c1 composite=0.5' }];
    const r = labelChange(rows, finalIds, stmts2, ctxLine('now in Delhi'), ['c1'], blocks);
    check(r.label === 'd', 'labelChange: d when S is retired, linked, with a reason, and only C is shown'); }

  // d0: same shape but the reason test fails (no cross reference).
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1, { superseded_by: 'c1' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const finalIds = new Set(['s1', 'c1']);
    const blocks = [{ id: 's1', text: '[1] s1 composite=0.1' }, { id: 'c1', text: '[2] c1 composite=0.5' }];
    const r = labelChange(rows, finalIds, stmts2, ctxLine('now in Delhi'), ['c1'], blocks);
    check(r.label === 'd0', 'labelChange: d0 when retired but no reason links S to C'); }

  // s: S shown, C not shown.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const r = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('moved to Mumbai'), ['s1'], []);
    check(r.label === 's', 'labelChange: s when only the stale value is shown'); }

  // n: neither shown.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const r = labelChange(rows, new Set(['s1', 'c1']), stmts2, '', [], []);
    check(r.label === 'n', 'labelChange: n when neither surface shows anything'); }

  // c: C shown, S active but not shown anywhere (vacuous win).
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const r = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('now in Delhi'), ['c1'], []);
    check(r.label === 'c', 'labelChange: c when current is shown and stale is shown nowhere');
    const ctxOnly = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('now in Delhi'), [], []);
    check(ctxOnly.label === 'c', 'labelChange: c from the context surface alone');
    const recallView = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('now in Delhi'), [], [], { context: false, recall: true });
    check(recallView.label === 'n', 'labelChange: the recall-only view ignores what context showed'); }

  // b: both shown, S wins on a surface where C also shows (current does not win everywhere S shows).
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const r = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('moved to Mumbai') + '\n' + ctxLine('now in Delhi'), ['s1', 'c1'], []);
    check(r.label === 'b', 'labelChange: b when both surfaces show S and C together with S ranked first'); }
}

function selftestAttribution(check, h) {
  const { row, stmts2 } = h;
  // attribution: own marker wins even when the other marker also appears.
  { const r1 = row('r1', 'local', 'moved from Delhi to Mumbai', 1, 1);
    computeValues([r1], stmts2);
    check(r1.values.has('mumbai') && r1.values.size === 1, 'attribution: own-step marker wins over a mentioned other marker'); }

  // attribution: echo (wrong statement's marker, none of its own) carries no value, and a derived copy of it carries none either.
  { const r1 = row('r1', 'local', 'still thinking about Delhi', 1, 1);
    const der = row('der', 'local', '[Consolidated from 2 related memories]\n\nstill thinking about Delhi', 3, null);
    computeValues([r1, der], stmts2);
    check(r1.values.size === 0 && r1.flags.includes('echo'), 'attribution: echo row carries no value and is flagged');
    check(der.values.size === 0 && !der.flags.includes('unlinked'), 'attribution: a derived row quoting an echo row carries no value and is linked'); }

  // attribution: derived row linked to one earlier member.
  { const src = row('src', 'local', 'now in Delhi for work', 2, 2);
    const der = row('der', 'local', '[Consolidated from 1 memory]\n\nnow in Delhi for work', 3, null);
    computeValues([src, der], stmts2);
    check(der.values.has('delhi') && !der.flags.includes('unlinked'), 'attribution: derived row inherits its source member\'s values'); }

  // attribution: derived row with no linkable source falls back to marker scan, flagged unlinked.
  { const der = row('der', 'local', '[Consolidated summary]\n\nliving in Delhi now', 3, null);
    computeValues([der], stmts2);
    check(der.values.has('delhi') && der.flags.includes('unlinked'), 'attribution: unlinked derived row falls back to a marker scan'); }

  // attribution: exact global copy inherits values and does not count as captured.
  { const loc = row('loc', 'local', 'now in Delhi', 2, 2);
    const glob = row('glob', 'global', 'now in Delhi', 4, null);
    const rows = new Map([['loc', loc], ['glob', glob]]);
    computeValues([loc, glob], stmts2);
    check(glob.values.has('delhi') && !glob.flags.includes('unlinked'), 'attribution: exact global copy inherits its local source\'s values');
    check(captured(2, 'Delhi', rows) && !captured(4, 'Delhi', rows), 'attribution: a global copy is never itself a captured carrier'); }

  // reversal: S (step-2 pnpm) captured but C (step-3 npm reassertion) never its own row gives a, missing new.
  // captured() binds on firstSeen.stmtK exactly, so a step-1 "npm" row cannot stand in for the step-3 one.
  { const rev = [{ marker: 'npm' }, { marker: 'pnpm' }, { marker: 'npm' }];
    const r1 = row('r1', 'local', 'use npm for installs', 1, 1);
    const r2 = row('r2', 'local', 'switched to pnpm for installs', 2, 2);
    const rows = new Map([['r1', r1], ['r2', r2]]);
    computeValues([r1, r2], rev);
    const r = labelChange(rows, new Set(['r1', 'r2']), rev, '', [], []);
    check(r.label === 'a' && r.detail.missing === 'new', 'reversal: S captured, step-3 C reassertion missing gives a with missing new'); }
}

function selftestParsers(check, h) {
  const { row } = h;
  // context regex: all three prefixes match; a substring hit inside a longer stored row does not.
  { const target = row('t', 'local', 'Always use tabs in the web repo.', 1, 1);
    check(contextShows(target, '- **[verified] Always use tabs in the web repo.** [tags]'), 'context: "] " prefix matches');
    check(contextShows(target, 'note): Always use tabs in the web repo.** end'), 'context: "): " prefix matches');
    // ⚠️ is the real warn-label suffix cli.ts prints (confWarning); a bare unrelated emoji has no VS16 and would not match.
    check(contextShows(target, '- **[stale] ⚠️ Always use tabs in the web repo.** end'), 'context: emoji-variation-selector prefix matches');
    const longer = row('l', 'local', 'Reminder: Always use tabs in the web repo. Also ship the changelog.', 1, 1);
    check(!contextShows(target, '] ' + longer.content + '**'), 'context: a row whose text is a substring of another shown row does not itself match'); }

  // explain block parsing: the rank table is excluded, a block ends at Note:.
  { const text = 'Rank  Score   ID\n1     0.5     mem_x  preview text\n\n[1] mem_x   composite=0.53\n    mode:      bm25-only\nNote: something\n[2] mem_y   composite=0.10\n    mode:      bm25-only';
    const blocks = parseExplainBlocks(text);
    check(blocks.length === 2 && blocks[0].id === 'mem_x' && !blocks[0].text.includes('Rank'), 'explain: rank table excluded from the first block');
    check(!blocks[0].text.includes('Note:'), 'explain: block ends at the Note: line'); }

  // R19: two "--- id [" lines must both survive (matchAll, not the first-only match()).
  { const out = '--- mem_a [0.90]\ntext one\n--- mem_b [0.40]\ntext two\n';
    const ids = parseRankedIds(out);
    check(ids.length === 2 && ids[0] === 'mem_a' && ids[1] === 'mem_b', 'recall parse: two ranked ids survive in order'); }

  // reason test: both directions pass, a bare status word with no cross reference fails.
  { const blocksS = [{ id: 's1', text: 'superseded by c1' }];
    check(reasonTest(blocksS, ['s1'], ['c1'], 'Mumbai', 'Delhi'), 'reason test: S block naming a C id passes');
    const blocksC = [{ id: 'c1', text: 'this replaced s1' }];
    check(reasonTest(blocksC, ['s1'], ['c1'], 'Mumbai', 'Delhi'), 'reason test: C block naming an S id passes');
    const bare = [{ id: 's1', text: 'status: superseded' }];
    check(!reasonTest(bare, ['s1'], ['c1'], 'Mumbai', 'Delhi'), 'reason test: a bare status word with no cross reference fails'); }
}

function selftestControl(check, h) {
  const { row } = h;
  // control: pass needs both statements stored; a restatement skipped as a duplicate counts as stored.
  { const ctrlStmts = [{ marker: 'Delhi' }, { marker: 'Delhi' }];
    const r1 = row('r1', 'local', 'I live in Delhi', 1, 1);
    const r2 = row('r2', 'local', 'Still based in Delhi', 2, 2);
    const rows = new Map([['r1', r1], ['r2', r2]]);
    computeValues([r1, r2], ctrlStmts);
    const pass = labelControl(ctrlStmts, rows, new Set(['r1', 'r2']), []);
    check(pass.label === 'pass' && pass.evaluable, 'control: both restatements stored and active passes');
    const deduped = labelControl(ctrlStmts, rows, new Set(['r1']), []);
    check(deduped.label === 'pass', 'control: a restatement deduped to one active copy still passes');
    const oneRows = new Map([['r1', r1]]);
    const dupSkip = labelControl(ctrlStmts, oneRows, new Set(['r1']), [], { arm: 'capture', captureOutcomes: [{ k: 2, outcome: { type: 'captured', n: 0, m: 1, r: 0 } }] });
    check(dupSkip.label === 'pass' && dupSkip.evaluable, 'control: statement 2 skipped as a duplicate of its stored twin is evaluable');
    const noCue = labelControl(ctrlStmts, oneRows, new Set(['r1']), [], { arm: 'capture', captureOutcomes: [{ k: 2, outcome: { type: 'no-cue' } }] });
    check(noCue.label === 'n/a' && !noCue.evaluable, 'control: statement 2 never stored gives n/a, not pass'); }
  { const ctrlStmts = [{ marker: 'Delhi' }, { marker: 'Delhi' }];
    const r1 = row('r1', 'local', 'I live in Delhi', 1, 1, { superseded_by: 'r2' });
    const r2 = row('r2', 'local', 'Still based in Delhi', 2, 2);
    const rows = new Map([['r1', r1], ['r2', r2]]);
    computeValues([r1, r2], ctrlStmts);
    check(labelControl(ctrlStmts, rows, new Set(['r1', 'r2']), []).label === 'pass', 'control: a restatement superseded by its own active copy passes');
    const r2gone = labelControl(ctrlStmts, rows, new Set(['r1']), []);
    check(r2gone.label === 'fail' && r2gone.failRetired, 'control: a retirement whose chain reaches no active same-value row fails'); }
  { const look = [{ marker: 'Delhi' }, { marker: 'Dehradun' }];
    const r1 = row('r1', 'local', 'I live in Delhi', 1, 1, { superseded_by: 'r2' });
    const r2 = row('r2', 'local', 'My sister lives in Dehradun', 2, 2);
    const rows = new Map([['r1', r1], ['r2', r2]]);
    computeValues([r1, r2], look);
    const fail = labelControl(look, rows, new Set(['r1', 'r2']), []);
    check(fail.label === 'fail' && fail.failRetired, 'control: a look-alike that retires the first value fails'); }
  { const ctrlStmts = [{ marker: 'Delhi' }, { marker: 'Delhi' }];
    computeValues([], ctrlStmts);
    const none = labelControl(ctrlStmts, new Map(), new Set(), []);
    check(none.label === 'n/a' && !none.evaluable, 'control: n/a when no value was ever captured'); }
  { const ctrlStmts = [{ marker: 'Delhi' }, { marker: 'Delhi' }];
    const r1 = row('r1', 'local', 'I live in Delhi', 1, 1);
    const rows = new Map([['r1', r1]]);
    computeValues([r1], ctrlStmts);
    const lost = labelControl(ctrlStmts, rows, new Set(), []);
    check(lost.label === 'fail' && lost.failLost, 'control: a captured value with no present carrier fails even when not evaluable'); }
}

function selftestVerdict(check) {
  // wilson(0, 20) upper bound is about 0.161.
  { const [lo, hi] = wilson(0, 20); check(lo === 0 && hi > 0.15 && hi < 0.17, 'wilson(0,20) upper bound is about 0.161'); }

  // verdict: PASS, FAIL, VOID, PARTIAL.
  { const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ id: `h${i}`, split: 'heldout', category: 'move', domain: 'personal', arm: 'capture', label: i < 18 ? 'd' : 'a', contextLabel: 'd', recallLabel: 'd', detail: {} });
    for (let i = 0; i < 5; i++) rows.push({ id: `hc${i}`, split: 'heldout', category: 'control-restate', domain: 'personal', arm: 'capture', label: 'pass', contextLabel: 'pass', recallLabel: 'pass', detail: {} });
    for (let i = 0; i < 40; i++) rows.push({ id: `o${i}`, split: i < 20 ? 'tune' : 'heldout', category: 'move', domain: 'personal', arm: 'oracle', label: 'd', contextLabel: 'd', recallLabel: 'd', detail: { reach: true } });
    const pass = computeVerdict(rows, { arms: null, only: null });
    check(pass.status === 'PASS', 'verdict: PASS at 18/20 d with clean controls and full oracle reach');
    const failRows = rows.map((r) => (r.arm === 'capture' && r.label === 'd' ? { ...r, label: 'a' } : r));
    const fail = computeVerdict(failRows.filter((r) => !(r.arm === 'capture' && r.split === 'heldout' && r.label === 'd')), { arms: null, only: null });
    check(fail.status === 'FAIL' || fail.status === 'VOID', 'verdict: not PASS once held-out d count drops');
    const voidRows = rows.map((r) => (r.arm === 'oracle' ? { ...r, label: 'x', detail: { reach: false } } : r));
    const voided = computeVerdict(voidRows, { arms: null, only: null });
    check(voided.status === 'VOID', 'verdict: VOID when oracle reach falls under 36/40');
    const partial = computeVerdict(rows, { arms: null, only: ['z6-aaaaaaaa'] });
    check(partial.status === 'PARTIAL', 'verdict: PARTIAL when --only was used');
    check(computeVerdict(rows, { arms: ['remember', 'oracle'], only: null }).status === 'PARTIAL', 'verdict: PARTIAL when --arms drops the capture arm');
    check(computeVerdict(rows, { arms: ['capture', 'remember', 'oracle'], only: null }).status === 'PARTIAL', 'verdict: PARTIAL when --arms drops oracle-sleep');
    check(computeVerdict(rows, { arms: [...ARMS], only: null }).status === 'PASS', 'verdict: all four arms named is a full run');
    const ctl = (labels) => rows.map((r) => (r.id.startsWith('hc') ? { ...r, label: labels[Number(r.id.slice(2))] } : r));
    check(computeVerdict(ctl(['pass', 'pass', 'pass', 'pass', 'n/a']), { arms: null, only: null }).status === 'PASS', 'verdict: 4 control passes and 1 n/a is PASS');
    check(computeVerdict(ctl(['pass', 'pass', 'pass', 'pass', 'fail']), { arms: null, only: null }).status === 'FAIL', 'verdict: any failed control is FAIL');
    check(computeVerdict(ctl(['pass', 'pass', 'pass', 'n/a', 'n/a']), { arms: null, only: null }).status === 'FAIL', 'verdict: 3 control passes is FAIL'); }
}

function selftestRetirementLinks(check, h) {
  const { row, ctxLine, stmts2 } = h;
  // R9: each retirement form is honoured.
  { for (const [label, r] of [
      ['superseded_by', row('r', 'local', 'x', 1, 1, { superseded_by: 'y' })],
      ['kind superseded', row('r', 'local', 'x', 1, 1, { kind: 'superseded' })],
      ['tag invalidated', row('r', 'local', 'x', 1, 1, { tags: ['invalidated'] })],
      ['tag superseded', row('r', 'local', 'x', 1, 1, { tags: ['superseded'] })],
      ['confidence stale', row('r', 'local', 'x', 1, 1, { confidence: 'stale' })],
    ]) check(isRetired(r), `retirement form recognized: ${label}`); }

  // A derived row does not show its source in context: the source's own line needs its text right after the label.
  { const src = row('src', 'local', 'now in Delhi for work', 2, 2);
    check(!contextShows(src, ctxLine('[Consolidated from 2 related memories]\n\nnow in Delhi for work')), 'context: a derived row quoting a source does not count as the source shown'); }

  // R9: link through a 2-hop superseded_by chain; a chain into a vanished row reaches nothing.
  { const a = row('a', 'local', 'x', 1, 1, { superseded_by: 'mid' });
    const mid = row('mid', 'local', 'y', 2, null, { superseded_by: 'c1' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['a', a], ['mid', mid], ['c1', c1]]);
    computeValues([a, mid, c1], stmts2);
    const present = new Set(['a', 'mid', 'c1']);
    check(chainReaches(a, rows, (n) => present.has(n.id) && n.values.has('delhi')), 'link: a 2-hop superseded_by chain reaches a present C carrier');
    check(!chainReaches(a, rows, (n) => n.id === 'zz'), 'link: a chain that never meets the target is false');
    const loop = row('l1', 'local', 'x', 1, 1, { superseded_by: 'l2' });
    const loop2 = row('l2', 'local', 'y', 2, 2, { superseded_by: 'l1' });
    check(!chainReaches(loop, new Map([['l1', loop], ['l2', loop2]]), () => false), 'link: a superseded_by cycle ends'); }

  // d0 with a dangling link: S points at a C row that sleep removed, while a later C row is shown.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1, { superseded_by: 'c1' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const c2 = row('c2', 'local', 'living in Delhi now', 3, 2);
    const rows = new Map([['s1', s1], ['c1', c1], ['c2', c2]]);
    computeValues([s1, c1, c2], stmts2);
    const blocks = [{ id: 's1', text: '[1] s1\nsuperseded by c1' }];
    const r = labelChange(rows, new Set(['s1', 'c2']), stmts2, ctxLine('living in Delhi now'), [], blocks);
    check(r.label === 'd0' && r.detail.danglingLinks === 1 && r.detail.unlinkedRetired === 1, 'link: a chain into a vanished C row is dangling and blocks d'); }

  // A stale S (not superseded_by) stays on the surfaces: counted as retired and shown, and labelled b.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1, { confidence: 'stale' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const r = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('moved to Mumbai') + '\n' + ctxLine('now in Delhi'), [], []);
    check(r.label === 'b' && r.detail.sRetired === 1 && r.detail.sRetiredShown === 1, 'retired-but-shown: a stale S still in context is counted and gives b'); }

  // The auto surface joins the union: S shown only there turns c into b; the auto-only view sees it alone.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const autoText = ctxLine('moved to Mumbai');
    const union = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('now in Delhi'), [], [], {}, { autoText });
    check(union.label === 'b', 'auto surface: S shown by context --auto keeps the union label off c');
    const hookOnly = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('now in Delhi'), [], [], { recall: false, auto: false }, { autoText });
    check(hookOnly.label === 'c', 'auto surface: the hook-context view ignores the auto output');
    const autoOnly = labelChange(rows, new Set(['s1', 'c1']), stmts2, ctxLine('now in Delhi'), [], [], { context: false, recall: false }, { autoText });
    check(autoOnly.label === 's', 'auto surface: the auto-only view sees S alone'); }
}

function selftestDiagnostics(check, h) {
  const { row, ctxLine, throwsHook, stmts2 } = h;
  // Derived-row diagnostics and the dedup value relation.
  { const s1 = row('s1', 'local', 'moved to Mumbai for the job', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi for the new job', 2, 2);
    const dc = row('dc', 'local', '[Consolidated from 2 related memories]\n\nnow in Delhi for the new job', 3, null);
    const dc2 = row('dc2', 'local', '[Consolidated from 2 related memories]\n\nnow in Delhi for the new job', 4, null);
    const rows = new Map([['s1', s1], ['c1', c1], ['dc', dc], ['dc2', dc2]]);
    computeValues([s1, c1, dc, dc2], stmts2);
    const forgetRows = [{ targetId: 'dc2', cause: 'dedup', survivorId: 'dc' }, { targetId: 's1', cause: 'dedup', survivorId: 'c1' }];
    const diag = changeDiagnostics(rows, new Set(['c1', 'dc']), 'mumbai', 'delhi', [], forgetRows);
    check(diag.derivedC === 1 && diag.derivedS === 0 && diag.derivedBoth === 0, 'diagnostics: a pair merge that kept the C text counts as derivedC');
    check(diag.dedupDeletions.length === 2 && diag.dedupDeletions[0].kept === 'older' && diag.dedupDeletions[0].value === 'same', 'diagnostics: a derived row deduped against its own earlier copy is older/same');
    check(diag.dedupDeletions[1].kept === 'newer' && diag.dedupDeletions[1].value === 'other', 'diagnostics: an S row deduped into a C row is newer/other'); }

  // The seven hook commands: the exact set passes; an extra or changed command voids the run.
  { const settings = () => ({ hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file "/t/s.log"' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'hippo last-sleep --path "/t/s.log"' }] }, { matcher: 'compact', hooks: [{ type: 'command', command: 'hippo compact-resume' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'hippo context --pinned-only --include-recent 5 --format additional-context' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'hippo pre-compact --log-file "/t/pc.log"' }] }],
      PostCompact: [{ hooks: [{ type: 'command', command: 'hippo post-compact --log-file "/t/pc.log"' }] }],
      PostToolUseFailure: [{ matcher: '.*', hooks: [{ type: 'command', command: 'hippo capture-error' }] }],
    } });
    check(checkHooks(settings()).logPath === '/t/s.log', 'hooks: the seven expected commands pass and give the session-end log');
    const extra = settings();
    extra.hooks.Stop = [{ hooks: [{ type: 'command', command: 'hippo supersede-scan' }] }];
    check(throwsHook(() => checkHooks(extra)), 'hooks: an eighth command voids the run');
    const changed = settings();
    changed.hooks.UserPromptSubmit[0].hooks[0].command = 'hippo context --auto --format additional-context';
    check(throwsHook(() => checkHooks(changed)), 'hooks: a changed prompt-hook command voids the run'); }

  // R9: a retired global S copy with no link gives d0.
  { const localS = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const globalS = row('gs', 'global', 'moved to Mumbai', 3, null, { superseded_by: null, confidence: 'stale' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', localS], ['gs', globalS], ['c1', c1]]);
    computeValues([localS, globalS, c1], stmts2);
    const finalIds = new Set(['gs', 'c1']);
    const r = labelChange(rows, finalIds, stmts2, ctxLine('now in Delhi'), ['c1'], []);
    check(r.label === 'd0', 'link: an unlinked retired global S copy blocks d and gives d0'); }

  // R7: filler guard counts present filler rows by retirement.
  { const bg = row('bg', 'local', 'The staging database snapshot runs nightly.', 5, null);
    const bgGone = row('gone', 'local', 'An old note.', 6, null);
    const fillerNorm = new Set([norm('The staging database snapshot runs nightly.'), norm('An old note.')]);
    const rows = new Map([['bg', bg], ['gone', bgGone]]);
    computeValues([bg, bgGone], stmts2);
    const counts = fillerCounts(rows, new Set(['bg']), fillerNorm);
    check(counts.fillerActive === 1 && counts.fillerRetired === 0, 'filler guard: present filler rows count as active when not retired'); }
}

function selftestWorkerAndGuards(check, h) {
  const { row, stmts2 } = h;
  // R4: oracle success additionally needs reach (explain lists an S and a C carrier).
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1, { superseded_by: 'c1' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const blocksNoS = [{ id: 'c1', text: '[1] c1 composite=0.5' }];
    const sKey = 'mumbai', cKey = 'delhi';
    const sIds = new Set([...rows.values()].filter((r) => r.values.has(sKey)).map((r) => r.id));
    const cIds = new Set([...rows.values()].filter((r) => r.values.has(cKey)).map((r) => r.id));
    const reach = blocksNoS.some((b) => sIds.has(b.id)) && blocksNoS.some((b) => cIds.has(b.id));
    check(!reach, 'oracle reach: false when explain never lists an S carrier'); }

  // R1/R14/R18: worker-log parsing, tested against the real parseWorkerLog, not a reimplementation that could drift.
  { check(parseWorkerLog('No actionable items found in the input.').ok === false, 'worker log: missing the two complete markers is rejected even with a clean outcome line');
    const noCue = parseWorkerLog('[hippo] sleep complete\n[hippo] capture complete\nNo actionable items found in the input.');
    check(noCue.ok && noCue.outcome.type === 'no-cue', 'worker log: a clean no-cue log passes');
    const cap2 = parseWorkerLog('[hippo] sleep complete\n[hippo] capture complete\nCaptured 2 items (1 skipped as duplicates)');
    check(cap2.ok && cap2.outcome.n === 2 && cap2.outcome.m === 1 && cap2.outcome.r === 0, 'worker log: a clean captured log passes and parses counts');
    const rej = parseWorkerLog('[hippo] sleep complete\n[hippo] capture complete\nCaptured 0 items (0 skipped as duplicates, 1 rejected)');
    check(rej.ok && rej.outcome.n === 0 && rej.outcome.r === 1, 'worker log: a rejected-only outcome still parses');
    check(!parseWorkerLog('[hippo] sleep failed: disk full\n[hippo] capture complete\nNo actionable items found in the input.').ok, 'worker log: a sleep-failed line with no sleep-complete line is rejected');
    check(!parseWorkerLog('[hippo] sleep complete\n[hippo] capture failed: parse error').ok, 'worker log: a capture-failed line with no capture-complete line is rejected');
    check(!parseWorkerLog('[hippo] sleep complete\n[hippo] capture complete\nNo text to capture from.').ok, 'worker log: "No text to capture from." is not a recognized outcome line');
    check(!parseWorkerLog('[hippo] sleep complete\n[hippo] capture complete\nCaptured 1 items (0 skipped as duplicates)\nCaptured 2 items (0 skipped as duplicates)').ok, 'worker log: two outcome lines is rejected');
    check(!parseWorkerLog('skip capture: no transcript').ok, 'worker log: misfed session, no transcript');
    check(!parseWorkerLog('No transcript found for session').ok, 'worker log: misfed session, transcript not found');
    check(!parseWorkerLog('had no user/assistant messages').ok, 'worker log: misfed session, empty session');
    check(!parseWorkerLog('skip: no session_id').ok, 'worker log: misfed session, no session id'); }

  // R2/R18: the daily-runner summary line, the only proof the exit code alone does not give.
  { check(dailyRunnerOk('Daily maintenance complete: 1 workspace processed, 0 command failures.'), 'daily-runner line: 1 workspace processed, 0 failures passes');
    check(!dailyRunnerOk('Daily maintenance complete: 0 workspaces processed, 0 command failures.'), 'daily-runner line: 0 workspaces processed fails');
    check(!dailyRunnerOk('Daily maintenance complete: 1 workspace processed, 1 command failure.'), 'daily-runner line: 1 command failure fails');
    check(!dailyRunnerOk('No registered Hippo workspaces found; nothing to do.'), 'daily-runner line: no-registry note fails'); }

  // R11/R18: root-base guard, tested as pure string logic so selftest creates no directory.
  { check(rootBaseOk(path.relative('/tmp', '/tmp/hz6q')), 'root-base guard: <tmp>/hz6q is accepted');
    check(!rootBaseOk(path.relative('/tmp', '/home/user/zzz')), 'root-base guard: a path outside the temp dir is refused');
    check(!rootBaseOk(''), 'root-base guard: the temp dir itself is refused');
    check(!rootBaseOk('..'), 'root-base guard: a path starting with .. is refused'); }
}

function selftestLossCauses(check, h) {
  const { row, stmts2 } = h;
  // R15/R18: filler rows lost (not just retired) count against the verdict, split out by cause.
  { const lost = row('lost', 'local', 'The staging database snapshot runs nightly.', 5, null);
    const fillerNorm = new Set([norm('The staging database snapshot runs nightly.')]);
    const rows = new Map([['lost', lost]]);
    computeValues([lost], stmts2);
    const forgetRows = [{ targetId: 'lost', cause: 'dedup', survivorId: 'kept' }];
    const counts = fillerCounts(rows, new Set(), fillerNorm, forgetRows, new Map());
    check(counts.fillerLost.dedup === 1 && fillerLostTotal(counts.fillerLost) === 1, 'filler guard: a vanished filler row is counted as fillerLost by cause');
    const seen = (id, firstHalfLife) => ({ id, firstHalfLife });
    check(vanishedCause(seen('d1', 365), [], new Map([['d1', 365]])) === 'dormant', 'vanished cause: dormant at its first half-life is dormant');
    check(vanishedCause(seen('d2', 365), [], new Map([['d2', 1]])) === 'merge-fade', 'vanished cause: dormant with a cut half-life is merge-fade');
    check(vanishedCause(seen('d3', 365), [{ targetId: 'd3', cause: 'dormant', survivorId: null }], new Map([['d3', 9]])) === 'merge-fade', 'vanished cause: a dormant forget row with a cut half-life is merge-fade');
    check(vanishedCause(seen('ghost', 365), [], new Map()) === 'unrecorded', 'vanished cause: no forget row and not dormant is unrecorded');
    const cl = carriersLost([seen('s1', 365), seen('s2', 365)], [seen('c1', 365)], new Set(['s2', 'c1']), [{ targetId: 's1', cause: 'dedup', survivorId: 'gone' }], new Map());
    check(cl.old.dedup === 1 && fillerLostTotal(cl.old) === 1 && fillerLostTotal(cl.new) === 0, 'carriers lost: a dedup whose survivor was never seen still counts');
    const sum = addCauses([{ dedup: 1, dormant: 0 }, undefined, { dedup: 2, unrecorded: 1 }]);
    check(sum.dedup === 3 && sum.unrecorded === 1, 'addCauses: sums per cause and skips missing entries'); }

  // R16/R18: reach is recorded in the capture arm too, not just oracle, and does not change the label.
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1, { superseded_by: 'c1' });
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const blocks = [{ id: 's1', text: '[1] s1' }, { id: 'c1', text: '[2] c1' }];
    const sIds = new Set([...rows.values()].filter((r) => r.values.has('mumbai')).map((r) => r.id));
    const cIds = new Set([...rows.values()].filter((r) => r.values.has('delhi')).map((r) => r.id));
    check(computeReach(blocks, sIds, cIds), 'reach: an explain listing both an S and a C id reaches, independent of arm');
    check(!computeReach([{ id: 'c1', text: '[1] c1' }], sIds, cIds), 'reach: explain listing only a C id does not reach'); }

  // a/x reason and cause fields, added alongside R11-R18 since the first draft recorded only missing/vanished.
  { const stmt2 = [{ marker: 'Mumbai' }, { marker: 'Delhi' }];
    const outcomes = [{ k: 1, outcome: { type: 'captured', n: 0, m: 2, r: 0 } }];
    const rows = new Map();
    computeValues([], stmt2);
    const a = labelChange(rows, new Set(), stmt2, '', [], [], undefined, { arm: 'capture', captureOutcomes: outcomes });
    check(a.label === 'a' && a.detail.reasons.old === 'dup', 'a-reason: capture arm with N=0,M>0 records dup');
    const aRemember = labelChange(rows, new Set(), stmt2, '', [], [], undefined, { arm: 'remember' });
    check(aRemember.detail.reasons.old === 'not-stored' && aRemember.detail.reasons.new === 'not-stored', 'a-reason: remember arm always records not-stored'); }
  { const s1 = row('s1', 'local', 'moved to Mumbai', 1, 1);
    const c1 = row('c1', 'local', 'now in Delhi', 2, 2);
    const rows = new Map([['s1', s1], ['c1', c1]]);
    computeValues([s1, c1], stmts2);
    const forgetRows = [{ targetId: 's1', cause: 'dedup', survivorId: 'x' }];
    const x = labelChange(rows, new Set(['c1']), stmts2, '', [], [], undefined, { forgetRows, dormant: new Map() });
    check(x.label === 'x' && x.detail.causes.old.dedup === 1, 'x-cause: a deduped vanished S carrier is recorded under causes.old.dedup'); }
}

async function selftest() {
  let n = 0;
  const check = (cond, msg) => { n++; assert.ok(cond, msg); };
  if (fs.existsSync(FIXTURE_DEFAULT)) {
    const fx = JSON.parse(fs.readFileSync(FIXTURE_DEFAULT, 'utf8'));
    selftestFixtureContract(fx, check);
    await selftestQuestionReach(fx, check);
  } else {
    console.log('fixture not present yet: fixture and question-reach checks skipped, labeller checks run alone');
  }
  selftestLabeller(check);
  console.log(`selftest OK (${n} checks)`);
}

// --- main ---

// dist/ is gitignored, so the built code a run measured is named by a hash of every file in it.
function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const files = fs.readdirSync(dir, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
  for (const f of files) h.update(`${f}\0`).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) { await selftest(); return; }
  if (args.compare) {
    const a = JSON.parse(fs.readFileSync(args.compare[0], 'utf8'));
    const b = JSON.parse(fs.readFileSync(args.compare[1], 'utf8'));
    compareResults(a, b);
    return;
  }

  const fixturePath = args.fixture ? path.resolve(args.fixture) : FIXTURE_DEFAULT;
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (fixture.background?.length !== 60 || fixture.interleave?.length !== 9) throw new Error('fixture shape looks wrong; run --selftest first');
  const rootBase = args.rootBase ? path.resolve(args.rootBase) : path.join(os.tmpdir(), 'hz6q');
  const outPath = args.out ? path.resolve(args.out) : OUT_DEFAULT;
  const tracePath = args.trace ? path.resolve(args.trace) : null;
  if (tracePath) fs.rmSync(tracePath, { force: true });

  checkRootBase(rootBase);
  probeKeysGone(buildEnv(rootBase, day(0)));
  checkNoEmbeddings();

  const tplInfo = buildTemplate(rootBase, fixture);
  const fillerNormSet = new Set([...fixture.background, ...fixture.interleave].map((n) => norm(n.text)));
  const wantArms = args.arms ?? ARMS;
  const unknownArms = wantArms.filter((a) => !ARMS.includes(a));
  if (unknownArms.length) throw new Error(`unknown arm(s): ${unknownArms.join(',')}`);
  const scenarios = args.only ? fixture.scenarios.filter((s) => args.only.includes(s.id)) : fixture.scenarios;

  const results = [];
  for (const scenario of scenarios) {
    const isChange = !scenario.category.startsWith('control');
    const arms = isChange ? wantArms : wantArms.filter((a) => !a.startsWith('oracle'));
    for (const arm of arms) {
      const t0 = Date.now();
      const res = await runScenarioArm(scenario, arm, rootBase, tplInfo, fixture, fillerNormSet, tracePath);
      console.log(`${scenario.id} ${arm}: ${res.label} (${Date.now() - t0}ms)`);
      results.push(res);
    }
  }

  const summary = buildSummary(results);
  const verdict = computeVerdict(results, args);
  const git = (...a) => spawnSync('git', ['-C', REPO, ...a], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const commit = git('rev-parse', '--short', 'HEAD');
  // A rebase rewrites HEAD, so the measured hippo code is named by the last src/ commit; -dirty flags local edits.
  const srcCommit = git('log', '-1', '--format=%h', '--', 'src') + (git('status', '--porcelain', '--', 'src') ? '-dirty' : '');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const fixtureSha256 = crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex');
  const out = {
    schema: 'z6-supersession-results/1', hippoVersion: pkg.version, commit, srcCommit, distSha256: hashDir(path.join(REPO, 'dist')), fixtureSha256,
    runArgs: { arms: args.arms, only: args.only }, verdict, summary, scenarios: results,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  printStdout(results, verdict);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
