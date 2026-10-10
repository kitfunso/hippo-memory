#!/usr/bin/env node
// Z7 sub-agent lesson eval, prereg docs/evals/2026-10-03-z7-sidechain-gap-prereg.md. Stdout carries counts only, never transcript or lesson text.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as L from './z7-sidechain-lib.mjs';
import { libSelftests } from './z7-sidechain-selftest.mjs';
import { guardScored, createMarker, appendLine, countResumes, startResume, refuseApiKey } from './z7-sidechain-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(REPO, 'scripts');
const PROMPT_DIR = path.join(SCRIPTS, 'z7-sidechain-prompts');
const PREREG = path.join(REPO, 'docs', 'evals', '2026-10-03-z7-sidechain-gap-prereg.md');
const SCRIPT_FILES = ['z7-sidechain-lib.mjs', 'z7-sidechain-eval.mjs', 'z7-sidechain-selftest.mjs', 'z7-sidechain-guard.mjs'].map((f) => path.join(SCRIPTS, f));
const DEFAULT_ARCHIVE = path.join(os.homedir(), 'hippo-archive', 'z7-sidechain-2026-10-03');
const MANIFEST_SHA = '84028a76df0a4c9b16ea4aaffcaed3284f26ef37985c4cd0a7837765496966e0';
const CONCURRENCY = 3;
const QUOTA_RE = /usage limit|rate limit|quota|overloaded|try again later/i;
const [SONNET, OPUS] = L.MODELS;
export const out = (k, v) => console.log(`${k}=${v}`);
export const fmt = (x) => (x === null ? 'n/a' : Number.isInteger(x) ? String(x) : x.toFixed(3));
export const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parseArgs(argv) {
  const a = { cmd: argv[0], archive: DEFAULT_ARCHIVE, split: null, round: null, resume: false, confirmed: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--archive') a.archive = argv[++i];
    else if (argv[i] === '--split') a.split = argv[++i];
    else if (argv[i] === '--round') a.round = Number(argv[++i]);
    else if (argv[i] === '--resume') a.resume = true;
    else if (argv[i] === '--confirmed') a.confirmed = Number(argv[++i]);
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!path.isAbsolute(a.archive)) throw new Error('--archive must be an absolute path');
  if (a.resume && a.cmd !== 'scored') throw new Error('--resume belongs to the scored command only');
  if (a.confirmed !== null && a.cmd !== 'audit-finalize') throw new Error('--confirmed belongs to audit-finalize only');
  return a;
}

// --- archive: every file opened is checked against the manifest ---

export function openArchive(archive) {
  const raw = fs.readFileSync(path.join(archive, 'manifest.json'));
  if (hash(raw) !== MANIFEST_SHA) throw new Error('manifest sha256 differs from the pinned value');
  const files = new Map(Object.values(JSON.parse(raw.toString('utf8')).files).map((f) => [f.rel.replace(/\\/g, '/'), f]));
  return {
    archive, files, work: path.join(archive, 'work'), manifestSha: hash(raw),
    read(rel) {
      const f = files.get(rel);
      if (!f) throw new Error(`not in manifest: ${rel}`);
      const buf = fs.readFileSync(path.join(archive, 'raw', rel));
      if (hash(buf) !== f.sha256) throw new Error(`sha256 mismatch: ${rel}`);
      return buf.toString('utf8');
    },
  };
}

export function layout(ar) {
  const sessions = new Map();
  const get = (sid) => sessions.get(sid) ?? sessions.set(sid, { sid, parent: null, subs: [], workflow: [] }).get(sid);
  for (const rel of ar.files.keys()) {
    const p = rel.split('/');
    if (p.length === 1 && rel.endsWith('.jsonl')) get(rel.slice(0, -6)).parent = rel;
    else if (p[1] === 'subagents' && p.length === 3 && rel.endsWith('.jsonl')) get(p[0]).subs.push(p[2]);
    else if (p[1] === 'subagents' && p[2] === 'workflows' && rel.endsWith('.jsonl')) get(p[0]).workflow.push(rel);
  }
  for (const s of sessions.values()) { s.subs.sort(); if (!s.parent) throw new Error(`session ${s.sid} has no parent transcript`); }
  return sessions;
}

export function readMeta(ar, sid, file) {
  const rel = `${sid}/subagents/${file.replace(/\.jsonl$/, '.meta.json')}`;
  return ar.files.has(rel) ? JSON.parse(ar.read(rel)) : null;
}

// --- scan, profile, draw ---

function ineligible(meta, sub, parent) {
  if (!meta) return 'no meta';
  if (meta.spawnDepth !== 1) return 'depth not 1';
  if (!parent.agentCalls.has(meta.toolUseId)) return 'toolUseId not in parent';
  if (parent.lastTs >= L.CUTOFF_TS) return 'parent session not closed before cutoff';
  if (sub.task === null) return 'no task found';
  if (sub.assistantChars < L.LIMITS.minAssistant) return 'under 200 assistant chars';
  return null;
}

export function scanArchive(ar) {
  const lay = layout(ar);
  const sessions = [];
  for (const s of [...lay.values()].sort((x, y) => byStr(x.sid, y.sid))) {
    const parent = L.readParent(ar.read(s.parent));
    const workflowBad = s.workflow.reduce((n, rel) => n + L.forEachEntry(ar.read(rel), () => {}), 0);
    const rec = { sid: s.sid, lastTs: parent.lastTs, project: L.workingProject(parent.cwds, os.homedir()), parentBad: parent.bad, workflowBad, workflow: s.workflow.length, subs: [] };
    for (const file of s.subs) {
      const meta = readMeta(ar, s.sid, file);
      const sub = L.readSubAgent(ar.read(`${s.sid}/subagents/${file}`), meta);
      rec.subs.push({
        file, meta, template: sub.task === null ? null : L.templateOf(sub.task), assistantChars: sub.assistantChars,
        errorsTotal: sub.errorsTotal, ordered: sub.ordered, orderedConv: sub.orderedConv, bad: sub.bad, why: ineligible(meta, sub, parent),
      });
    }
    sessions.push(rec);
  }
  return sessions;
}

export const eligibleItems = (sessions) => sessions.flatMap((s) => s.subs.filter((x) => !x.why).map((x) => ({
  session: s.sid, file: x.file, template: x.template, agentType: x.meta.agentType, project: s.project,
})));

function cmdProfile(a) {
  const ar = openArchive(a.archive);
  const sessions = scanArchive(ar);
  const subs = sessions.flatMap((s) => s.subs);
  const files = [...ar.files.values()];
  const mt = files.filter((f) => f.rel.includes('/subagents/')).map((f) => f.mtime.slice(0, 10)).sort();
  const groups = new Map();
  for (const x of subs) if (x.template !== null) groups.set(x.template, (groups.get(x.template) ?? 0) + 1);
  const multi = [...groups.values()].filter((n) => n >= 2);
  const chars = subs.map((x) => x.assistantChars);
  const why = {};
  for (const x of subs) if (x.why) why[x.why] = (why[x.why] ?? 0) + 1;
  const perSession = sessions.map((s) => s.subs.length);
  out('files', files.length);
  out('bytes', files.reduce((n, f) => n + f.bytes, 0));
  out('manifest_sha_ok', true);
  out('sessions', sessions.length);
  out('subagent_transcripts', subs.length);
  out('subagent_meta', subs.filter((x) => x.meta).length);
  out('workflow_transcripts', sessions.reduce((n, s) => n + s.workflow, 0));
  out('subagent_files_written', `${mt[0]}..${mt[mt.length - 1]}`);
  out('out_of_order_transcripts', subs.filter((x) => !x.ordered).length);
  out('out_of_order_conversation_entries', subs.filter((x) => !x.orderedConv).length);
  out('bad_lines', sessions.reduce((n, s) => n + s.parentBad + s.workflowBad, 0) + subs.reduce((n, x) => n + x.bad, 0));
  out('assistant_chars_min_median_max', `${Math.min(...chars)} ${L.median(chars)} ${Math.max(...chars)}`);
  out('subagents_without_assistant_text', chars.filter((c) => c === 0).length);
  out('subagents_with_error_result', subs.filter((x) => x.errorsTotal > 0).length);
  out('template_groups_of_2plus', `${multi.length} groups, ${multi.reduce((n, g) => n + g, 0)} transcripts`);
  out('subagents_per_session_max_median', `${Math.max(...perSession)} ${L.median(perSession)}`);
  for (const [k, v] of Object.entries(why).sort()) out(`ineligible[${k}]`, v);
  const el = eligibleItems(sessions);
  out('eligible_subagents', el.length);
  out('eligible_sessions', new Set(el.map((i) => i.session)).size);
}

export function writeIdempotent(file, data) {
  const text = L.isStr(data) ? data : JSON.stringify(data, null, 1);
  if (fs.existsSync(file)) { if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`${path.basename(file)} exists and differs; refusing to overwrite`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
}

function cmdDraw(a) {
  const ar = openArchive(a.archive);
  const draw = L.buildDraw(eligibleItems(scanArchive(ar)));
  writeIdempotent(path.join(ar.work, 'draw.json'), draw);
  out('eligible_subagents', draw.eligibleSubs);
  out('eligible_sessions', draw.eligibleSessions);
  out('dev_sessions', draw.devSessions.length);
  out('dev_items', draw.dev.length);
  out('scored_sessions_with_items', new Set(draw.scored.map((id) => draw.items[id].session)).size);
  out('scored_n', draw.scored.length);
  out('scored_item_list_sha256', draw.itemListSha256);
}

const readDraw = (ar) => JSON.parse(fs.readFileSync(path.join(ar.work, 'draw.json'), 'utf8'));

// --- build: blocks A, B, C and the parent side for each drawn sub-agent ---

async function loadDeps() {
  const imp = (f) => import(pathToFileURL(path.join(REPO, 'dist', f)).href);
  const [cap, same, sec] = await Promise.all([imp('capture.js'), imp('util/same-text.js'), imp('util/secret-detect.js')]);
  return { summarise: cap.summariseTranscript, extract: cap.extractFromText, dupKey: same.duplicateKey, mask: sec.maskEmails, redact: sec.redactSecretsStrict };
}
const captureItems = (d, jsonl) => d.extract(d.mask(d.redact(d.summarise(jsonl)))).map((i) => i.content);

function pendingReports(owner, meta, sub) {
  return sub.reports.map((text, k) => ({ owner, k, text, toolUseId: meta?.toolUseId, prefix: L.reportPrefix(text), arrival: null }));
}

function assembleItem(x, sid, m, pending, capture, project, augment) {
  const mine = pending.filter((p) => p.owner === x.file);
  const { windows, cut } = L.buildWindows(m, mine.filter((p) => p.arrival !== null).map((p) => p.arrival));
  const saves = [...new Set([...L.dedupeSaves(m.stream), ...x.sub.saves])];
  const { B, ranges, cutChars } = L.renderB(x.sub.items);
  const A = x.sub.task.slice(0, L.LIMITS.A);
  const C = L.renderC(capture, windows, saves);
  const parentSide = L.parentSideSegments(m.stream, capture, x.sub.saves).join('\n\n');
  const aug = augment ? pending.filter((p) => p.owner !== x.file && p.arrival !== null).map((p) => p.text) : null;
  const flags = {
    bCutChars: cutChars, windowsCut: cut, reports: mine.length, reached: mine.filter((p) => p.arrival !== null).length,
    errorsRendered: x.sub.items.filter((i) => i.kind === 'error').length, errorsTotal: x.sub.errorsTotal, subBad: x.sub.bad,
    windows: windows.length, captureItems: capture.length, saves: saves.length, cChars: C.length, parentSideChars: parentSide.length,
  };
  const item = {
    id: x.id, session: sid, file: x.file, agentType: x.meta?.agentType, project, A, B, C, ranges, captureItems: capture, flags,
    cut: cutChars > 0 || cut > 0, parentSideFile: `${x.id}.parent.txt`, augmentFile: aug ? `${x.id}.aug.txt` : null,
  };
  return { item, parentSide, aug };
}

function buildSession(ar, deps, lay, sid, wanted, augment) {
  const s = lay.get(sid);
  const parentText = ar.read(s.parent);
  const loaded = wanted.map(({ id, file }) => {
    const meta = readMeta(ar, sid, file);
    return { id, file, meta, sub: L.readSubAgent(ar.read(`${sid}/subagents/${file}`), meta) };
  });
  const pending = loaded.flatMap((x) => pendingReports(x.file, x.meta, x.sub));
  if (augment) {
    for (const file of s.subs.filter((f) => !wanted.some((w) => w.file === f))) {
      const meta = readMeta(ar, sid, file);
      if (meta?.spawnDepth === 1) pending.push(...pendingReports(file, meta, L.readSubAgent(ar.read(`${sid}/subagents/${file}`), meta)));
    }
  }
  const m = L.readParent(parentText, pending);
  const capture = captureItems(deps, parentText);
  const project = L.workingProject(m.cwds, os.homedir());
  return loaded.map((x) => assembleItem(x, sid, m, pending, capture, project, augment));
}

export function writeOut(dir, name, data, idem) {
  fs.mkdirSync(dir, { recursive: true });
  if (idem) return writeIdempotent(path.join(dir, name), data);
  fs.writeFileSync(path.join(dir, name), L.isStr(data) ? data : JSON.stringify(data, null, 1));
}

export async function buildIds(ar, dir, ids, draw, idem, augment) {
  const deps = await loadDeps();
  const lay = layout(ar);
  const bySession = new Map();
  for (const id of ids) {
    const it = draw.items[id];
    bySession.set(it.session, [...(bySession.get(it.session) ?? []), { id, file: it.file }]);
  }
  const built = [];
  for (const [sid, wanted] of bySession) {
    for (const { item, parentSide, aug } of buildSession(ar, deps, lay, sid, wanted, augment)) {
      writeOut(dir, `${item.id}.json`, item, idem);
      writeOut(dir, item.parentSideFile, parentSide, idem);
      if (aug) writeOut(dir, item.augmentFile, aug.join('\n\n'), idem);
      built.push(item);
    }
  }
  return built;
}

export const loadBuilt = (dir, ids) => ids.map((id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')));

export function printBuild(items) {
  const sum = (f) => items.reduce((n, i) => n + f(i.flags), 0);
  out('items', items.length);
  out('sessions', new Set(items.map((i) => i.session)).size);
  out('reports', sum((f) => f.reports));
  out('reports_reached_parent', sum((f) => f.reached));
  out('b_cut', items.filter((i) => i.flags.bCutChars > 0).length);
  out('c_window_cut', items.filter((i) => i.flags.windowsCut > 0).length);
  out('errors_rendered', sum((f) => f.errorsRendered));
  out('bad_lines', sum((f) => f.subBad));
  out('c_chars_max', Math.max(...items.map((i) => i.flags.cChars)));
  out('parent_side_chars_max', Math.max(...items.map((i) => i.flags.parentSideChars)));
}

// --- claude -p ---

export const promptText = (name, dir = PROMPT_DIR) => fs.readFileSync(path.join(dir, name), 'utf8');
export const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

export function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  // Only a real .exe: Node refuses to spawn a .cmd shim with shell:false, and a shell would re-quote the prompt.
  const r = spawnSync('where', ['claude'], { encoding: 'utf8' });
  const exe = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
  if (!exe) throw new Error('claude.exe not found on PATH');
  return exe;
}

function runClaude(exe, model, system, prompt, cwd) {
  const args = ['-p', '--safe-mode', '--model', model, '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--system-prompt', system];
  return new Promise((resolve) => {
    const p = spawn(exe, args, { cwd, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => p.kill(), 600000);
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.on('error', () => {});
    p.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(e) }); });
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    p.stdin.end(prompt);
  });
}

export function makeCtx(dir, opts = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'z7-judge-'));
  const callsDir = path.join(dir, 'calls');
  fs.mkdirSync(callsDir, { recursive: true });
  const promptDir = opts.promptDir ?? PROMPT_DIR;
  return { dir, cwd, callsDir, exe: resolveClaudeExe(), promptDir, seedPrefix: opts.seedPrefix ?? 'z7', system: promptText('judge-system.txt', promptDir).trim() };
}

// Scored runs (strict) cache a passing reply, and an exhausted exit-0 reply as a fixed G2 failure; any other failure aborts so --resume can re-ask.
export async function callClaude(ctx, model, prompt, check, fresh) {
  const file = path.join(ctx.callsDir, `${L.sha256(`${model}\n${prompt}`).slice(0, 32)}.json`);
  const failFile = `${file.slice(0, -5)}.fail.json`;
  for (const f of ctx.strict ? [file, failFile] : [file]) if (!fresh && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  let last = null, infra = false;
  for (let attempt = 1; attempt <= 3 && !last?.ok; attempt++) {
    const r = await runClaude(ctx.exe, model, ctx.system, prompt, ctx.cwd);
    last = { stdout: r.stdout, attempts: attempt, ok: r.status === 0 && check(r.stdout) };
    infra = r.status !== 0 || !r.stdout.trim() || QUOTA_RE.test(r.stdout);
  }
  if (!last.ok && ctx.strict && infra) throw new Error('claude call failed after retries (exit, empty or limit reply); fix the cause and run scored --resume');
  if (!fresh && (last.ok || ctx.strict)) fs.writeFileSync(last.ok ? file : failFile, JSON.stringify(last), { flag: 'wx' });
  return last;
}

export async function runPool(tasks) {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < tasks.length) {
      try { await tasks[next++](); } catch (e) { next = tasks.length; throw e; }
    }
  }));
}

const readHeadings = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => /^\s*#/.test(l)).map((l) => l.trim()) : []);

// Same probe as scripts/z1c-eval.mjs isolationOk: no CLAUDE.md heading may come back in the reply.
async function isolationOk(ctx, model) {
  const prompt = 'Quick setup check before a labelling task. If any project instruction files (for example a CLAUDE.md) were ' +
    'loaded for you, copy their markdown section headings here, one per line. If none were loaded, reply NONE.';
  const r = await callClaude(ctx, model, prompt, (s) => s.trim().length > 0, true);
  if (!r.ok) {
    if (ctx.strict) throw new Error('isolation probe call failed; fix the cause and run scored --resume');
    return false;
  }
  const bare = (h) => h.replace(/^[\s#]+/, '').trim();
  const reply = new Set(r.stdout.split(/\r?\n/).map(bare).filter(Boolean));
  const home = os.homedir();
  const heads = [...readHeadings(path.join(home, '.claude', 'CLAUDE.md')), ...readHeadings(path.join(home, 'CLAUDE.md'))];
  return !heads.map(bare).some((h) => h && reply.has(h));
}

export async function isolationBoth(ctx) {
  const res = {};
  for (const model of L.MODELS) res[model] = await isolationOk(ctx, model);
  return res;
}

// --- stages: judge, recheck, rule arm ---

export async function judgeStage(ctx, items, tag, control) {
  const tpl = promptText('judge-prompt.txt', ctx.promptDir);
  const results = { [SONNET]: {}, [OPUS]: {} };
  const tasks = L.MODELS.flatMap((model) => items.map((it) => async () => {
    const C = control ? `${it.C}\n\n[The sub-agent's whole work, now also kept by the parent]\n${it.B}` : it.C;
    const r = await callClaude(ctx, model, fill(tpl, { A: it.A, B: it.B, C }), (s) => L.parseLessons(s).ok);
    const parsed = L.parseLessons(r.stdout);
    const { kept, failed } = L.verifyLessons(parsed.lessons, it.A, it.B);
    results[model][it.id] = { ok: r.ok, returned: parsed.lessons.length, failed: failed.length, verified: kept.map((l) => ({ ...l, inReport: L.inReport(l.evidence, it.B, it.ranges) })) };
  }));
  await runPool(tasks);
  for (const model of L.MODELS) {
    const ordered = Object.fromEntries(items.map((it) => [it.id, results[model][it.id]]));
    results[model] = ordered;
    writeOut(ctx.dir, `judge-${tag}-${model}.json`, ordered, ctx.idem);
  }
  return results;
}

async function recheckItem(ctx, tpl, it, judge, decoyPool, prior) {
  const real = L.MODELS.flatMap((m) => (judge[m][it.id]?.verified ?? []).map((l, k) => ({ src: m, k, kind: l.kind, text: l.text })));
  const ask = prior ? real.filter((l) => !prior.keptKeys.includes(`${l.src}:${l.k}`)) : real;
  if (!ask.length) return prior;
  const rng = L.rngFromString(`${ctx.seedPrefix}-decoy|${it.id}${prior ? '|aug' : ''}`);
  const coinPlanted = rng() < 0.5;
  const picked = L.pickDecoy(decoyPool, { id: it.id, session: it.session, project: it.project, kinds: real.map((l) => l.kind) }, rng);
  let side = fs.readFileSync(path.join(ctx.dir, it.parentSideFile), 'utf8');
  if (prior) side += `\n\n${fs.readFileSync(path.join(ctx.dir, it.augmentFile), 'utf8')}`;
  let chunks = L.chunkSegments([side]);
  if (picked && coinPlanted) chunks = L.plantDecoy(chunks, picked.lesson.text, rng).chunks;
  const { list, decoyIdx } = L.recheckList(ask, picked?.lesson ?? null, rng);
  const kept = new Set();
  let callsOk = 0;
  for (let c = 0; c < chunks.length; c++) {
    const lessons = list.map((l, i) => `${i}. ${l.text}`).join('\n');
    const r = await callClaude(ctx, OPUS, fill(tpl, { PART: c + 1, PARTS: chunks.length, PARENT_SIDE: chunks[c], LESSONS: lessons }), (s) => L.parseKept(s, list.length).ok);
    if (r.ok) callsOk++;
    for (const k of L.parseKept(r.stdout, list.length).kept) kept.add(k);
  }
  const keptKeys = [...(prior?.keptKeys ?? []), ...list.flatMap((l, i) => (l.src !== 'decoy' && kept.has(i) ? [`${l.src}:${l.k}`] : []))];
  return {
    keptKeys, callsTotal: chunks.length, callsOk, decoy: !picked ? 'skipped' : coinPlanted ? 'planted' : 'unplanted',
    decoyKept: decoyIdx >= 0 && kept.has(decoyIdx), flag: picked?.flag ?? null, chunks: chunks.length,
  };
}

// Rechecks every item where either judge verified a lesson, so the union share is also taken after the recheck.
export async function recheckStage(ctx, items, judge, name, priorMap) {
  const tpl = promptText('recheck-prompt.txt', ctx.promptDir);
  const verified = (m, id) => judge[m][id]?.verified ?? [];
  const decoyPool = items.map((it) => ({ id: it.id, session: it.session, project: it.project, lessons: L.MODELS.flatMap((m) => verified(m, it.id).map(({ kind, text }) => ({ kind, text }))) })).filter((p) => p.lessons.length);
  const res = {};
  const todo = items.filter((it) => L.MODELS.some((m) => verified(m, it.id).length) && (!priorMap || priorMap[it.id]));
  await runPool(todo.map((it) => async () => { res[it.id] = await recheckItem(ctx, tpl, it, judge, decoyPool, priorMap?.[it.id]); }));
  const ordered = Object.fromEntries(todo.map((it) => [it.id, res[it.id]]));
  writeOut(ctx.dir, name, ordered, ctx.idem);
  return ordered;
}

async function ruleArmStage(ctx, ar, deps, items) {
  const tpl = promptText('rule-arm-prompt.txt');
  const res = {};
  await runPool(items.map((it) => async () => {
    const all = deps.extract(deps.summarise(L.stripForkPrefix(ar.read(`${it.session}/subagents/${it.file}`)))).map((i) => i.content);
    const keys = new Set(it.captureItems.map(deps.dupKey));
    const novel = all.filter((c) => !keys.has(deps.dupKey(c)));
    res[it.id] = { total: all.length, items: novel.length, yes: 0, ok: true, texts: novel };
    if (!novel.length) return;
    const r = await callClaude(ctx, OPUS, fill(tpl, { A: it.A, ITEMS: novel.map((t, i) => `${i}. ${t}`).join('\n') }), (s) => L.parseRuleLabels(s, novel.length).ok);
    res[it.id].ok = r.ok;
    res[it.id].yes = L.parseRuleLabels(r.stdout, novel.length).labels.filter(Boolean).length;
  }));
  const ordered = Object.fromEntries(items.map((it) => [it.id, res[it.id]]));
  writeOut(ctx.dir, 'rule-arm.json', ordered, ctx.idem);
  return ordered;
}

// --- figures, printing, dev commands ---

export const asRows = (items) => items.map((it) => ({ id: it.id, session: it.session, agentType: it.agentType, cut: it.cut }));
export const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
export const gatesOf = (f, isolation, control) => L.gateResults({ isolation, parse: f.parse, evidenceFail: f.evidenceFail, control, unplanted: f.unplanted, planted: f.planted });

export function printFigures(f, g) {
  out('n', f.n);
  out('before_recheck_both_judges', f.pBefore);
  out('lesson_overturned_by_recheck', f.overturned);
  out('lesson_bearing_both_judges', f.consensus);
  out('lesson_bearing_either_judge', f.union);
  out('p_consensus', fmt(f.consensus / (f.n || 1)));
  for (const [m, v] of Object.entries(f.perJudge)) out(`p_${m}`, fmt(v / (f.n || 1)));
  out('kappa_before_recheck', fmt(f.kappa));
  out('bearing_with_lesson_in_report', f.inReport);
  out('G2_parse', JSON.stringify(g.G2));
  out('G3_evidence', JSON.stringify(g.G3));
  out('G4_control', fmt(g.G4 === null ? null : g.G4 ? 1 : 0));
  out('decoy_unplanted_kept', f.unplanted.join('/'));
  out('decoy_planted_kept', f.planted.join('/'));
  out('decoy_skipped', f.decoySkipped);
  out('G5_pass', g.G5);
  out('G6_pass', g.G6);
  out('kind_mix', JSON.stringify(f.kindMix));
  out('by_class_bearing_of_n', JSON.stringify(f.byClass));
}

function needDev(a) {
  if (a.split !== 'dev') throw new Error('this command takes --split dev; the scored split runs only inside the scored command');
  if (!(a.round >= 1 && a.round <= 3)) throw new Error('--round must be 1, 2 or 3');
}

function devSetup(a) {
  needDev(a);
  const ar = openArchive(a.archive);
  const draw = readDraw(ar);
  const dir = path.join(ar.work, 'dev');
  const ids = draw.dev.filter((id) => !draw.scored.includes(id));
  if (ids.length !== draw.dev.length) throw new Error('dev list overlaps the scored list');
  return { ar, draw, dir, ids };
}

async function cmdBuildDev(a) {
  const { ar, draw, dir, ids } = devSetup({ ...a, round: 1 });
  printBuild(await buildIds(ar, dir, ids, draw, false, false));
}

async function cmdJudgeDev(a) {
  const { dir, ids } = devSetup(a);
  const items = loadBuilt(dir, ids);
  const ctx = { ...makeCtx(dir), idem: false };
  const iso = await isolationBoth(ctx);
  writeOut(dir, `isolation-r${a.round}.json`, iso, false);
  if (Object.values(iso).includes(false)) throw new Error('G1 isolation failed; no labelled call was made');
  const res = await judgeStage(ctx, items, `r${a.round}`, false);
  for (const m of L.MODELS) out(`judged_${m}`, Object.keys(res[m]).length);
}

export const loadJudge = (dir, tag) => ({ [SONNET]: readJson(dir, `judge-${tag}-${SONNET}.json`), [OPUS]: readJson(dir, `judge-${tag}-${OPUS}.json`) });

async function cmdRecheckDev(a) {
  const { dir, ids } = devSetup(a);
  const items = loadBuilt(dir, ids);
  const res = await recheckStage({ ...makeCtx(dir), idem: false }, items, loadJudge(dir, `r${a.round}`), `recheck-r${a.round}.json`, null);
  out('rechecked_items', Object.keys(res).length);
}

function devFigures(a) {
  const { dir, ids } = devSetup(a);
  const items = loadBuilt(dir, ids);
  const judge = loadJudge(dir, `r${a.round}`);
  const recheck = readJson(dir, `recheck-r${a.round}.json`);
  const iso = fs.existsSync(path.join(dir, `isolation-r${a.round}.json`)) ? readJson(dir, `isolation-r${a.round}.json`) : null;
  const f = L.figures(asRows(items), judge, recheck);
  return { f, g: gatesOf(f, iso ? !Object.values(iso).includes(false) : null, null), dir };
}

function cmdScoreDev(a) {
  const { f, g } = devFigures(a);
  printFigures(f, g);
}

function cmdCalib(a) {
  const { f, dir } = devFigures({ ...a, split: 'dev' });
  const lines = [`# Dev calibration, round ${a.round}`, '', 'Confirm a sub-agent only if a surviving lesson is durable, not recoverable, and absent from its parent side file.', ''];
  for (const r of f.rows.filter((x) => x.both)) {
    lines.push(`## ${r.id}`, `parent side: ${path.join(dir, `${r.id}.parent.txt`)}`);
    for (const [m, ls] of [[SONNET, r.s1], [OPUS, r.s2]]) for (const l of ls) lines.push(`- ${m} [${l.kind}] ${l.text}`);
    lines.push('');
  }
  writeOut(dir, `calib-r${a.round}.md`, lines.join('\n'), false);
  out('lesson_bearing_dev_items', f.rows.filter((x) => x.both).length);
}

// --- scored run: lock config, draw check, stages ---

export const claudeVersion = () => spawnSync(resolveClaudeExe(), ['--version'], { encoding: 'utf8' }).stdout.trim();
const lockConfig = () => ({ repo: REPO, prereg: PREREG, scriptFiles: SCRIPT_FILES, promptDir: PROMPT_DIR, distDir: path.join(REPO, 'dist'), claudeVersion, lockDir: path.join(os.homedir(), '.hippo-eval-locks') });

// The draw is recomputed from the verified archive, so a stale or edited draw.json cannot stand.
function checkDraw(ar, draw, pins) {
  const bad = L.checkPins(pins, { manifest: ar.manifestSha });
  if (bad.length) throw new Error(`pin mismatch: ${bad.join(', ')}`);
  const why = L.drawMismatch(L.buildDraw(eligibleItems(scanArchive(ar))), draw, pins.scoredList);
  if (why) throw new Error(`draw.json refused: ${why}`);
}

async function cmdScored(a) {
  const lock = guardScored(lockConfig(), a.resume);
  const ar = openArchive(a.archive);
  const draw = readDraw(ar);
  if (L.sha256(draw.scored.join('\n')) !== draw.itemListSha256) throw new Error('scored list does not match its recorded sha256');
  checkDraw(ar, draw, lock.pins);
  const dir = path.join(ar.work, 'scored');
  if (a.resume) startResume(lock, draw.itemListSha256, dir);
  else createMarker(lock, draw.itemListSha256);
  const ctx = { ...makeCtx(dir), idem: true, strict: true };
  const iso = await isolationBoth(ctx);
  const failedIso = Object.values(iso).includes(false);
  if (!fs.existsSync(path.join(dir, 'isolation.json'))) writeOut(dir, 'isolation.json', iso, true);
  if (a.resume) appendLine(path.join(dir, 'isolation-resumes.jsonl'), { iso });
  if (a.resume && failedIso) throw new Error('G1 isolation failed on resume; no labelled call was made');
  if (failedIso) {
    writeOut(dir, 'result.json', { verdict: 'INVALID', failed: 'G1' }, true);
    out('verdict', 'INVALID (G1 isolation)');
    return;
  }
  const items = await buildIds(ar, dir, draw.scored, draw, true, true);
  printBuild(items);
  const judge = await judgeStage(ctx, items, 'final', false);
  const controlIds = L.shuffled([...draw.scored].sort(byStr), L.rngFromString('z7-control')).slice(0, 30);
  const controlItems = items.filter((it) => controlIds.includes(it.id));
  const ctl = await judgeStage({ ...ctx, idem: true }, controlItems, 'control', true);
  const control = L.controlFigures(ctl, controlItems.map((it) => it.id));
  const recheck = await recheckStage(ctx, items, judge, 'recheck-final.json', null);
  const aug = await recheckStage(ctx, items, judge, 'recheck-aug.json', recheck);
  const deps = await loadDeps();
  const rule = await ruleArmStage(ctx, ar, deps, items);
  finishScored(ctx, items, judge, recheck, aug, rule, { iso, control, lock, draw });
}

function ruleSummary(rule) {
  const rs = Object.values(rule);
  const per = rs.map((r) => r.items);
  const yes = rs.reduce((n, r) => n + r.yes, 0), total = per.reduce((n, x) => n + x, 0);
  return {
    subagents: rs.length, withItems: per.filter((x) => x > 0).length, itemsMean: total / (rs.length || 1), itemsMedian: L.median(per),
    labelledYes: yes, labelledItems: total, yesShare: total ? yes / total : null, callsOk: rs.filter((r) => r.ok).length,
  };
}

function finishScored(ctx, items, judge, recheck, aug, rule, run) {
  const rows = asRows(items);
  const f = L.figures(rows, judge, recheck);
  const fAug = L.figures(rows, judge, { ...recheck, ...Object.fromEntries(Object.entries(aug).map(([id, v]) => [id, { ...recheck[id], keptKeys: v.keptKeys }])) });
  const ci = L.clusterBootstrap(f.rows.map((r) => ({ cluster: r.session, hit: r.both })));
  const unionCi = L.clusterBootstrap(f.rows.map((r) => ({ cluster: r.session, hit: r.either })));
  const g = gatesOf(f, true, run.control);
  const valid = L.gatesValid(g);
  const result = {
    lockCommit: run.lock.lockCommit, itemListSha256: run.draw.itemListSha256, n: f.n, sessions: ci.clusters, intervalWidth: ci.width,
    p: ci.p, ci: [ci.lo, ci.hi], union: { p: unionCi.p, ci: [unionCi.lo, unionCi.hi] }, beforeRecheck: f.pBefore, overturned: f.overturned,
    consensus: f.consensus, unionCount: f.union, perJudge: f.perJudge, kappa: f.kappa, lessonsPerItem: f.lessonsPerItem, kindMix: f.kindMix,
    byClass: f.byClass, bearingWithLessonInReport: f.inReport, cutShare: f.cutShare, pWithOtherReports: fAug.consensus / (f.n || 1),
    gates: g, gatesUntested: Object.entries(g).filter(([, v]) => v === null).map(([k]) => k), decoy: { unplanted: f.unplanted, planted: f.planted, skipped: f.decoySkipped },
    control: run.control, ruleArm: ruleSummary(rule), valid, resumes: countResumes(run.lock), verdict: L.verdict(ci, unionCi, valid), auditRequired: L.verdict(ci, unionCi, valid) === 'BUILD',
  };
  writeOut(ctx.dir, 'result.json', result, true);
  printFigures(f, g);
  out('n_sessions', ci.clusters);
  out('p', fmt(ci.p));
  out('p_ci95', `${fmt(ci.lo)} ${fmt(ci.hi)}`);
  out('p_union_ci95', `${fmt(unionCi.p)} ${fmt(unionCi.lo)} ${fmt(unionCi.hi)}`);
  out('interval_width', fmt(ci.width));
  out('p_with_other_reports', fmt(result.pWithOtherReports));
  out('control_items_parsed_by_both', `${run.control.parsed}/${run.control.total}`);
  out('control_parse_ok_sonnet_opus', `${run.control.parse.sonnet.join('/')} ${run.control.parse.opus.join('/')}`);
  out('rule_arm', JSON.stringify(result.ruleArm));
  out('verdict', result.verdict);
}

function cmdAudit(a) {
  const ar = openArchive(a.archive);
  const dir = path.join(ar.work, 'scored');
  const result = readJson(dir, 'result.json');
  const draw = readDraw(ar);
  const items = loadBuilt(dir, draw.scored);
  const recheck = readJson(dir, 'recheck-final.json');
  const f = L.figures(asRows(items), loadJudge(dir, 'final'), recheck);
  const bearing = f.rows.filter((r) => r.both).map((r) => r.id).sort(byStr);
  const sample = L.shuffled(bearing, L.rngFromString('z7-audit')).slice(0, 10);
  writeOut(dir, 'audit.json', { seed: 'z7-audit', verdict: result.verdict, bearing: bearing.length, ids: sample }, true);
  const lines = ['# Precision audit sample', ''];
  for (const r of f.rows.filter((x) => sample.includes(x.id))) {
    lines.push(`## ${r.id}`, `parent side: ${path.join(dir, `${r.id}.parent.txt`)}`);
    for (const [m, ls] of [[SONNET, r.s1], [OPUS, r.s2]]) for (const l of ls) lines.push(`- ${m} [${l.kind}] ${l.text}`);
    lines.push('');
  }
  writeOut(dir, 'audit.md', lines.join('\n'), true);
  out('lesson_bearing_scored', bearing.length);
  out('audit_sample', sample.length);
}

// Writes the verdict after the precision audit once, and only after audit.json exists.
function cmdAuditFinalize(a) {
  if (!Number.isInteger(a.confirmed) || a.confirmed < 0) throw new Error('--confirmed K must be a non-negative integer');
  const dir = path.join(openArchive(a.archive).work, 'scored');
  if (fs.existsSync(path.join(dir, 'audit-result.json'))) throw new Error('audit-result.json exists; the audit is finalised once');
  if (!fs.existsSync(path.join(dir, 'audit.json'))) throw new Error('audit.json is missing; run audit first');
  const n = readJson(dir, 'audit.json').ids.length;
  if (a.confirmed > n) throw new Error(`--confirmed ${a.confirmed} exceeds the sample of ${n}`);
  const rec = L.finalizeAudit(readJson(dir, 'result.json').verdict, n, a.confirmed);
  fs.writeFileSync(path.join(dir, 'audit-result.json'), JSON.stringify(rec, null, 1), { flag: 'wx' });
  out('audit_sample', rec.sampleN);
  out('audit_confirmed', rec.confirmed);
  out('audit_share', fmt(rec.share));
  out('verdict_preliminary', rec.preliminary);
  out('verdict_final', rec.final);
}

// The exe is a path that cannot spawn, so any reply that comes back was read from the cache.
async function selftestCache(t) {
  const callsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z7-calls-'));
  try {
    const key = (p) => L.sha256(`m\n${p}`).slice(0, 32);
    fs.writeFileSync(path.join(callsDir, `${key('pass')}.json`), JSON.stringify({ stdout: 'cached', attempts: 1, ok: true }));
    fs.writeFileSync(path.join(callsDir, `${key('fail')}.fail.json`), JSON.stringify({ stdout: 'bad', attempts: 3, ok: false }));
    const ctx = { callsDir, exe: path.join(callsDir, 'no-such-claude'), system: 's', cwd: callsDir, strict: true };
    const never = () => false;
    t('a passing cached reply is reused, never re-asked', (await callClaude(ctx, 'm', 'pass', never, false)).stdout === 'cached');
    t('an exhausted exit-0 failure is reused in a strict run', (await callClaude(ctx, 'm', 'fail', never, false)).ok === false);
    let aborted = false;
    try { await callClaude(ctx, 'm', 'unseen', never, false); } catch { aborted = true; }
    const f1 = path.join(callsDir, 'idem.json'), f2 = path.join(callsDir, 'idem.txt');
    const throws = (fn) => { try { fn(); return false; } catch (err) { return /differs/.test(err.message); } };
    writeIdempotent(f1, { a: 1 });
    writeIdempotent(f2, 'text body');
    writeIdempotent(f1, { a: 1 });
    writeIdempotent(f2, 'text body');
    t('writeIdempotent accepts identical content, JSON and text', true);
    t('writeIdempotent refuses different content, JSON and text', throws(() => writeIdempotent(f1, { a: 2 })) && throws(() => writeIdempotent(f2, 'other')));
    t('a strict call that cannot run aborts instead of recording a failure', aborted && !fs.existsSync(path.join(callsDir, `${key('unseen')}.fail.json`)));
  } finally {
    fs.rmSync(callsDir, { recursive: true, force: true });
  }
}

export async function runSelftests(t) {
  for (const group of libSelftests) group(t);
  await selftestCache(t);
}

async function selftest() {
  let n = 0;
  const failed = [];
  const t = (name, ok) => { n++; if (!ok) failed.push(name); };
  await runSelftests(t);
  console.log(`selftest: ${n} cases, ${failed.length} failed`);
  for (const name of failed) console.log(`FAIL: ${name}`);
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.cmd === 'selftest') return await selftest();
  if (['judge', 'recheck', 'scored'].includes(a.cmd)) refuseApiKey(process.env);
  const table = {
    profile: cmdProfile, draw: cmdDraw, build: cmdBuildDev, judge: cmdJudgeDev, recheck: cmdRecheckDev,
    score: cmdScoreDev, calib: (x) => cmdCalib(x), scored: cmdScored, audit: cmdAudit, 'audit-finalize': cmdAuditFinalize,
  };
  if (!table[a.cmd]) throw new Error(`unknown command ${a.cmd}`);
  return table[a.cmd](a);
}

const isMain = path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1] ?? '').toLowerCase();
if (isMain) main().catch((e) => { console.error(`z7: ${e.message}`); process.exit(1); });
