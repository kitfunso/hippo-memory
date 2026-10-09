#!/usr/bin/env node
// Z6 automatic supersession, shipped baseline: prereg docs/evals/2026-09-28-z6-supersession-prereg.md.
// Prints AGGREGATE NUMBERS ONLY to stdout: never memory text, transcript text, user names or local paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { norm } from './z6-supersession/fixture.mjs';
import {
  ARMS, wilson, computeValues, isRetired, carriersLost, addCauses, computeReach, contextShows,
  labelChange, labelControl, fillerCounts, fillerLostTotal, changeDiagnostics, computeVerdict,
} from './z6-supersession/scoring.mjs';
import { rootBaseOk, dailyRunnerOk, parseWorkerLog, checkHooks, parseRankedIds, parseExplainBlocks } from './z6-supersession/output-checks.mjs';
import { selftest } from './z6-supersession/selftest.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin', 'hippo.js');
const FIXTURE_DEFAULT = path.join(REPO, 'benchmarks', 'z6-supersession', 'fixture.json');
const OUT_DEFAULT = path.join(REPO, 'benchmarks', 'z6-supersession', 'results.json');
const EPOCH_MS = Date.parse('2026-09-01T09:00:00.000Z');
const ALL_LABELS = ['a', 'x', 'd', 'd0', 's', 'n', 'c', 'b'];
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

const isStr = (v) => Object.prototype.toString.call(v) === '[object String]';

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

function assertBm25Only(blocks) {
  for (const b of blocks) {
    const m = /^\s*mode:\s+(\S+)/m.exec(b.text);
    if (!m || m[1] !== 'bm25-only') throw new Error(`explain block ${b.id} mode is not bm25-only`);
  }
}

// --- one (scenario, arm) run ---

// What the ask saw goes in as one object, so labelling stays a step apart from the run loop.
function labelScenarioArm(scenario, arm, seen) {
  const { rows, finalIds, extras, filler, captureOutcomes, contextText, autoText, rankedIds, blocks } = seen;
  const K = scenario.statements.length;
  const isChange = !scenario.category.startsWith('control');
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
  return { label, detail, contextLabel, recallLabel, autoLabel };
}

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

  const seen = { rows, finalIds, extras, filler, captureOutcomes, contextText, autoText, rankedIds, blocks };
  const { label, detail, contextLabel, recallLabel, autoLabel } = labelScenarioArm(scenario, arm, seen);

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
  if (args.selftest) { await selftest(FIXTURE_DEFAULT, path.join(REPO, 'dist')); return; }
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
