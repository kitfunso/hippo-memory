#!/usr/bin/env node
// Z0 SessionEnd capture extractor v2: prereg docs/evals/2026-09-28-z0-session-capture-v2-prereg.md.
// Prints AGGREGATE NUMBERS ONLY to stdout: never transcript text, memory text or private paths.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const SINCE = '2026-09-27T23:00:00.000Z';
const FREEZE_TAG = 'z0-extractor-v2-freeze';
const FREEZE_SHA = '764f73f767528a5d09f476aa8ef38ded286ee754';
// Session files expire after 30 days, so the first window sessions start to go on this date.
const DEADLINE = '2026-10-27T00:00:00.000Z';
const MIN_SESSIONS = 110;
const MIN_A1 = 15;
const SAMPLE = 100;
const SEED = 20260928;
const MARKER = 'z0-capture-v2.json';
const OWN_WORK = /\b(z0-capture|session-extract|capture-extractor|extractSessionMemories|sessionCaptureWindow)\b/i;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUBRIC = `You label short notes that a tool saved automatically from a coding agent's work session. A later agent will read each note on its own, with no other context. Label each note USEFUL or NOT_USEFUL.

Ask these four questions in order. The first "no" makes the note NOT_USEFUL. A note is USEFUL only when all four answers are "yes".

1. Subject. Does the note itself name what it is about: a specific component, file, command, tool, library, service, project, practice or person? A reader with no session context must be able to tell which thing it means. A note whose only subject is "the fix", "the cause", "the issue", "the problem", "it", "this", "the script" or "the test", with nothing saying which one, fails.
2. Content. Does it state a decision, rule, preference, lesson, gotcha, cause or lasting fact that could change what a later agent does? A general maxim that would apply to any project fails.
3. Durable. Would it still be true and worth knowing next week? Progress or status ("the build passes", "the PR is open"), a one-off instruction for that moment ("run it again"), a question, and a narration of what the agent just did ("Added the flag and pushed") fail.
4. Whole. Is it a complete statement? A fragment, a table row, a code line or a heading fails.

Be strict on question 1: a note that is true but does not say what it is about fails, however reasonable it sounds.

Worked examples (invented):
- "The fix is to raise the timeout to 30 seconds." NOT_USEFUL (1: which timeout, in what?)
- "The fix for the flaky upload test in upload.spec.ts is to raise its timeout to 30 seconds, because CI runners are slower than laptops." USEFUL
- "The root cause was a stale cache entry." NOT_USEFUL (1)
- "Always keep things simple and avoid unnecessary complexity." NOT_USEFUL (2: a maxim with no subject)
- "The billing service must never call the payments API without an idempotency key, because retries double-charge." USEFUL
- "Added a regression test and pushed the branch." NOT_USEFUL (3)
- "The staging deploy passed its smoke check." NOT_USEFUL (3)
- "I prefer pnpm over npm in this monorepo because installs are faster." USEFUL
- "must never run migrations on" NOT_USEFUL (4)

Output one line per note and nothing else: \`<id> USEFUL\` or \`<id> NOT_USEFUL\`.`;

function parseArgs(argv) {
  const out = { selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--projects') out.projects = argv[++i];
    else if (a === '--frozen-corpus') out.frozen = argv[++i];
    else if (a === '--tune') out.tune = argv[++i];
    else if (a === '--dist') out.dist = argv[++i];
    else if (a === '--selftest') out.selftest = true;
  }
  return out;
}

// shared math

// Same PRNG as z1c-eval.mjs: Math.random is banned for reproducibility.
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

function agreement(a, b) {
  const n = a.length;
  if (n === 0) return { n: 0, agree: 0, raw: null, kappa: null };
  let agree = 0, aYes = 0, bYes = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i] === 'U') aYes++;
    if (b[i] === 'U') bYes++;
  }
  const po = agree / n, pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  return { n, agree, raw: po, kappa: pe === 1 ? 1 : (po - pe) / (1 - pe) };
}

function wilson(k, m) {
  if (!m) return [0, 0];
  const z = 1.96, p = k / m, d = 1 + (z * z) / m;
  const c = (p + (z * z) / (2 * m)) / d, w = (z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m))) / d;
  return [c - w, c + w];
}

function parseLabels(text) {
  const map = new Map();
  let pending = null;
  for (const line of String(text).split(/\r?\n/)) {
    const one = /^[\s#*`-]*(?:note\s*|item\s*)?(\d+)[\s:.)*`-]*(USEFUL|NOT[_ ]USEFUL)\b/i.exec(line);
    const head = /^[\s#*]*(?:note|item)\s*(\d+)[\s:*]*$/i.exec(line);
    const bare = /^[\s*`]*(USEFUL|NOT[_ ]USEFUL)[\s*`.]*$/i.exec(line);
    const lab = (s) => (/^not/i.test(s) ? 'N' : 'U');
    if (one) { map.set(Number(one[1]), lab(one[2])); pending = null; }
    else if (head) pending = Number(head[1]);
    else if (bare && pending !== null) { map.set(pending, lab(bare[1])); pending = null; }
  }
  return map;
}

// transcripts

function parseLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

// Attempt-1 family-split filter (30+ chars, human-typed, not a notice), plus array text as the extractor now reads it.
function userText(content) {
  const str = (v) => (Object.prototype.toString.call(v) === '[object String]' ? String(v) : '');
  if (!Array.isArray(content)) return str(content);
  if (content.some((b) => b?.type === 'tool_result')) return '';
  return content.filter((b) => b?.type === 'text').map((b) => str(b.text).trim())
    .filter((t) => t && !t.startsWith('[Request interrupted by user')).join('\n');
}

function humanMessages(entries) {
  const out = [];
  for (const e of entries) {
    if (e?.type !== 'user') continue;
    if (e.isMeta || e.isSidechain || e.isCompactSummary || e.promptSource === 'system') continue;
    const c = userText(e.message?.content).trim();
    if (c.length < 30 || c.startsWith('<') || c.startsWith('This session is being continued')) continue;
    out.push(c);
  }
  return out;
}

function earliestTs(entries) {
  let min = Infinity;
  for (const e of entries) {
    const t = e?.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(t) && t < min) min = t;
  }
  return min;
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

function listJsonl(dir, recursive) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    else if (recursive && e.isDirectory()) out.push(...listJsonl(p, true));
  }
  return out.sort();
}

// Eligibility of one fresh-window session; returns the exclusion reason or null.
function exclusion(text, entries, sinceMs, outDir, frozenMsgs) {
  const first = earliestTs(entries);
  if (!Number.isFinite(first) || first < sinceMs) return 'before';
  for (const e of entries) {
    // Extractor dev sessions on the extractor branches, even when they never type a module name.
    if (e?.gitBranch && /capture-extractor/i.test(String(e.gitBranch))) return 'ownWork';
    // Amendment 1: `claude -p` runs are scripted wherever they ran; a path rule missed the TE5 pilot.
    // Decided per entry, so the reason counter depends on entry order; eligibility does not.
    if (e?.entrypoint === 'sdk-cli') return 'headless';
    if (!e?.cwd) continue;
    if (String(e.cwd).split(/[\\/]/).includes('eval-runs')) return 'evalRuns';
    if (outDir && isPathInside(e.cwd, outDir)) return 'scratch';
  }
  if (OWN_WORK.test(text)) return 'ownWork';
  const typed = entries.some((e) => {
    if (e?.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || e.promptSource === 'system') return false;
    const t = userText(e.message?.content).trim();
    return t && !t.startsWith('<');
  });
  if (!typed) return 'noHuman';
  const human = humanMessages(entries);
  if (human.some((m) => frozenMsgs.has(m))) return 'frozenOverlap';
  return null;
}

function frozenMessages(dir) {
  const set = new Set();
  for (const f of listJsonl(dir, true)) for (const m of humanMessages(parseLines(fs.readFileSync(f, 'utf8')))) set.add(m);
  return set;
}

function collectFresh(projectsDir, outDir, frozenMsgs) {
  const sinceMs = Date.parse(SINCE);
  const kept = [];
  const excluded = { before: 0, evalRuns: 0, headless: 0, scratch: 0, ownWork: 0, frozenOverlap: 0, noHuman: 0 };
  for (const pd of fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const file of listJsonl(path.join(projectsDir, pd.name), false)) {
      const text = fs.readFileSync(file, 'utf8');
      const entries = parseLines(text);
      const why = exclusion(text, entries, sinceMs, outDir, frozenMsgs);
      if (why) { excluded[why]++; continue; }
      kept.push({ project: pd.name, file });
    }
  }
  return { kept, excluded };
}

// build the frozen extractor

function run(cmd, args, cwd, shell = false) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell, maxBuffer: 1024 * 1024 * 50, timeout: 900000 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0]} failed (exit ${r.status})`);
  return r.stdout;
}

function buildFrozen(outDir) {
  const sha = run('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', `${FREEZE_TAG}^{commit}`]).trim();
  if (sha !== FREEZE_SHA) throw new Error(`${FREEZE_TAG} points at ${sha}, the prereg locks ${FREEZE_SHA}`);
  const buildDir = path.join(outDir, 'build');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const tar = path.join(outDir, 'build.tar');
  run('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tar, sha]);
  // Relative archive path: GNU tar (Git Bash) reads a drive-letter path as host:path.
  run('tar', ['-xf', path.join('..', 'build.tar')], buildDir);
  // Fixed arguments only: the shell is needed because npm is a .cmd shim on Windows.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], buildDir, process.platform === 'win32');
  run(process.execPath, [path.join(buildDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], buildDir);
  return { sha, dist: path.join(buildDir, 'dist') };
}

// arms

async function runArms(dist, files) {
  const cap = await import(pathToFileURL(path.join(dist, 'capture.js')).href);
  const se = await import(pathToFileURL(path.join(dist, 'session-extract.js')).href);
  const rows = [];
  const sessions = [];
  files.forEach((file, si) => {
    const jsonl = fs.readFileSync(file, 'utf8');
    const turns = cap.collectSessionTurns(jsonl);
    if (!turns.some((t) => t.role === 'user')) return;
    sessions.push(si);
    const summary = cap.summariseTranscript(jsonl);
    for (const it of summary ? cap.extractFromText(summary) : []) rows.push({ session: si, arm: 'A0', text: it.content });
    for (const it of se.extractSessionMemories(cap.sessionCaptureWindow(turns))) rows.push({ session: si, arm: 'A1', text: it.content });
    for (const it of se.extractSessionMemories(turns)) rows.push({ session: si, arm: 'A2', text: it.content });
  });
  return { rows, sessions };
}

function buildPool(rows) {
  const texts = [...new Set(rows.map((r) => r.text))].sort();
  const pool = seededShuffle(texts, SEED).map((text, id) => ({ id, text }));
  const sample = seededShuffle(pool.map((p) => p.id), SEED + 1).slice(0, SAMPLE).sort((a, b) => a - b);
  return { pool, sample };
}

// labellers (same isolation as z1c-eval.mjs)

function resolveClaudeExe() {
  if (process.platform !== 'win32') return 'claude';
  // Only a real .exe: Node refuses to spawn a .cmd shim with shell:false, and a shell would re-quote the prompt.
  const r = spawnSync('where', ['claude'], { encoding: 'utf8' });
  const exe = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
  if (!exe) throw new Error('claude.exe not found on PATH');
  return exe;
}

function callClaude(model, prompt, cwd) {
  const args = [
    '-p', '--safe-mode', '--model', model, '--tools', '', '--no-session-persistence', '--strict-mcp-config',
    '--system-prompt', 'You label items. Follow the user message exactly.',
  ];
  const exe = resolveClaudeExe();
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = spawnSync(exe, args, { cwd, input: prompt, encoding: 'utf8', timeout: 600000, shell: false, maxBuffer: 1024 * 1024 * 20 });
    if (r.status === 0) break;
  }
  return r;
}

// Fail closed: anything but a bare NONE (a refusal, a heading, an error) blocks the run.
function isolationOk(model, cwd) {
  const prompt =
    'Quick setup check before a labelling task. If any project instruction files (for example a CLAUDE.md) were ' +
    'loaded for you, copy their markdown section headings here, one per line. If none were loaded, reply NONE.';
  const r = callClaude(model, prompt, cwd);
  return r.status === 0 && /^none\.?$/i.test((r.stdout || '').trim());
}

// Batches of 20; a batch missing any id is re-asked once; still missing => null (VOID).
function label(model, items, cwd) {
  const labels = new Map();
  let retries = 0;
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20);
    const prompt = `${RUBRIC}\n\n${batch.map((it) => `Note ${it.id}: ${it.text}`).join('\n')}`;
    const parsed = parseLabels(callClaude(model, prompt, cwd).stdout);
    if (batch.some((it) => !parsed.has(it.id))) {
      retries++;
      for (const [k, v] of parseLabels(callClaude(model, prompt, cwd).stdout)) if (!parsed.has(k)) parsed.set(k, v);
      if (batch.some((it) => !parsed.has(it.id))) return { labels: null, retries };
    }
    for (const it of batch) labels.set(it.id, parsed.get(it.id));
  }
  return { labels, retries };
}

// scoring

function score({ rows, sessions }, pool, sample, opus, sonnet) {
  const idOf = new Map(pool.map((p) => [p.text, p.id]));
  const ag = agreement(sample.map((id) => opus.get(id)), sample.map((id) => sonnet.get(id)));
  const arms = {};
  for (const arm of ['A0', 'A1', 'A2']) {
    const mine = rows.filter((r) => r.arm === arm);
    const useful = mine.filter((r) => opus.get(idOf.get(r.text)) === 'U').length;
    const per = sessions.map((s) => mine.filter((r) => r.session === s).length);
    arms[arm] = {
      n: mine.length, useful, rate: mine.length ? useful / mine.length : 0, wilson: wilson(useful, mine.length),
      perSessionMean: sessions.length ? mine.length / sessions.length : 0, perSessionMax: per.length ? Math.max(...per) : 0,
      zeroSessions: per.filter((x) => x === 0).length,
    };
  }
  const { A0, A1, A2 } = arms;
  // Integer comparisons: 0.6 as a float product misfires at the boundary.
  const rules = {
    r1: A1.n >= MIN_A1,
    r2: 5 * ag.agree >= 4 * ag.n && ag.n > 0,
    r3: 5 * A1.useful >= 3 * A1.n,
    r4: 4 * (A1.useful * A0.n - A0.useful * A1.n) >= A0.n * A1.n,
    r5: 5 * A1.useful >= 4 * A0.useful,
    r6: A1.perSessionMax <= 3,
  };
  const verdict = !rules.r1 || !rules.r2 ? 'NO VERDICT' : rules.r3 && rules.r4 && rules.r5 && rules.r6 ? 'A1 SHIPS' : 'FAIL';
  const a2Clears = 5 * A2.useful >= 3 * A2.n && 4 * (A2.useful * A0.n - A0.useful * A2.n) >= A0.n * A2.n && 5 * A2.useful >= 4 * A0.useful;
  const a2Close = 20 * (A2.useful * A1.n - A1.useful * A2.n) >= -(A1.n * A2.n) && A2.useful >= A1.useful;
  const window = verdict === 'A1 SHIPS' && a2Clears && a2Close ? 'WHOLE SESSION' : 'TAIL';
  return { sessions: sessions.length, pool: pool.length, agreement: ag, arms, rules, verdict, window };
}

function selftest() {
  assert.deepEqual(agreement(['U', 'N', 'U', 'N'], ['U', 'N', 'U', 'N']), { n: 4, agree: 4, raw: 1, kappa: 1 });
  const w = wilson(15, 25);
  assert.ok(w[0] > 0.40 && w[0] < 0.41 && w[1] > 0.76 && w[1] < 0.77);
  const p = parseLabels('0 USEFUL\n1 NOT_USEFUL\nNote 2: NOT USEFUL\n**3** USEFUL\nNote 4\nNOT_USEFUL\nabc USEFUL\n5x USEFUL');
  assert.deepEqual([...p.entries()], [[0, 'U'], [1, 'N'], [2, 'N'], [3, 'U'], [4, 'N']]);
  const ts = (t, extra = {}) => ({ timestamp: t, ...extra });
  const since = Date.parse(SINCE);
  const human = { type: 'user', message: { content: 'please keep the release notes short and plain for every tag' } };
  assert.equal(exclusion('', [ts('2026-09-27T22:59:59Z'), ts('2026-09-29T10:00:00Z')], since, null, new Set()), 'before');
  assert.equal(exclusion('', [ts('2026-09-28T10:00:00Z', { cwd: '/w/eval-runs/x' })], since, null, new Set()), 'evalRuns');
  assert.equal(exclusion('', [{ ...ts('2026-09-28T10:00:00Z'), ...human, cwd: '/a/te5-pilot/runs/w', entrypoint: 'sdk-cli' }], since, null, new Set()), 'headless');
  assert.equal(exclusion('', [{ ...ts('2026-09-28T10:00:00Z'), ...human, entrypoint: 'cli' }], since, null, new Set()), null);
  assert.equal(exclusion('see scripts/z0-capture-eval.mjs', [ts('2026-09-28T10:00:00Z')], since, null, new Set()), 'ownWork');
  assert.equal(exclusion('', [{ ...ts('2026-09-28T10:00:00Z'), ...human, gitBranch: 'fix/capture-extractor-3' }], since, null, new Set()), 'ownWork');
  assert.equal(exclusion('', [{ ...ts('2026-09-28T10:00:00Z'), ...human }], since, null, new Set([human.message.content])), 'frozenOverlap');
  assert.equal(exclusion('', [{ ...ts('2026-09-28T10:00:00Z'), ...human }], since, null, new Set()), null);
  assert.equal(exclusion('', [{ type: 'user', message: human.message }], since, null, new Set()), 'before');
  const arr = { type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: human.message.content }] } };
  assert.equal(exclusion('', [{ ...ts('2026-09-28T10:00:00Z'), ...arr }], since, null, new Set([human.message.content])), 'frozenOverlap');
  // r4 at the exact boundary: 0.35 vs 0.10 is a 0.25 gain and must pass.
  const rowsOf = (arm, n, u) => Array.from({ length: n }, (_, i) => ({ session: 0, arm, text: i < u ? 'U' + arm + i : 'N' + arm + i }));
  const rows = [...rowsOf('A0', 20, 2), ...rowsOf('A1', 20, 7)];
  const allPool = [...new Set(rows.map((r) => r.text))].map((text, id) => ({ id, text }));
  const lab = new Map(allPool.map((p) => [p.id, p.text.startsWith('U') ? 'U' : 'N']));
  const s = score({ rows, sessions: [0] }, allPool, allPool.map((p) => p.id), lab, lab);
  assert.equal(s.rules.r4, true);
  assert.equal(s.rules.r3, false);
  console.log('selftest ok');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) { selftest(); return; }
  if (!args.out) { console.log('usage: --out <dir outside the repo> --frozen-corpus <dir> | --tune <dir> [--dist <dir>]'); process.exit(1); }
  const tune = Boolean(args.tune);
  if (args.dist && !tune) { console.log('refused: --dist is for --tune only; the scored run builds the freeze tag'); process.exit(1); }
  const outDir = path.resolve(args.out);
  if (isPathInside(outDir, REPO_ROOT)) { console.log('refused: --out is inside the repo'); process.exit(1); }
  // No --home override: the one-run marker must sit where every run looks.
  const home = os.homedir();
  const marker = path.join(home, '.hippo-eval-locks', MARKER);
  // Refuse before any cleanup, so a refused rerun cannot wipe the scored run's evidence.
  if (!tune && fs.existsSync(marker)) { console.log('refused: marker exists, a rerun needs a committed prereg amendment'); process.exit(4); }
  if (!tune && Date.now() >= Date.parse(DEADLINE)) { console.log(`refused: past the ${DEADLINE.slice(0, 10)} deadline, record NO VERDICT`); process.exit(7); }
  if (fs.existsSync(path.join(outDir, 'result.json'))) { console.log('refused: --out holds a scored run'); process.exit(4); }
  fs.mkdirSync(outDir, { recursive: true });

  let files, counts;
  if (tune) {
    files = listJsonl(path.resolve(args.tune), true);
    const late = files.filter((f) => earliestTs(parseLines(fs.readFileSync(f, 'utf8'))) >= Date.parse(SINCE)).length;
    if (late) { console.log(`refused: ${late} tune sessions start inside the fresh window`); process.exit(1); }
    counts = { mode: 'tune', files: files.length };
  } else {
    if (!args.frozen) { console.log('refused: --frozen-corpus is required'); process.exit(1); }
    const projectsDir = path.resolve(args.projects || path.join(home, '.claude', 'projects'));
    const { kept, excluded } = collectFresh(projectsDir, outDir, frozenMessages(path.resolve(args.frozen)));
    const corpus = path.join(outDir, 'corpus');
    fs.rmSync(corpus, { recursive: true, force: true });
    files = kept.map((k) => {
      const dest = path.join(corpus, k.project, path.basename(k.file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(k.file, dest);
      return dest;
    });
    counts = { mode: 'scored', since: SINCE, kept: kept.length, excluded, minSessions: MIN_SESSIONS };
  }
  console.log(JSON.stringify({ counts }, null, 2));
  if (!tune && files.length < MIN_SESSIONS) {
    console.log(`window short: ${files.length} eligible sessions, need ${MIN_SESSIONS}`);
    process.exit(3);
  }

  const build = tune && args.dist ? { sha: 'working-tree', dist: path.resolve(args.dist) } : buildFrozen(outDir);
  const armsRun = await runArms(build.dist, files);
  if (!tune && armsRun.sessions.length < MIN_SESSIONS) {
    console.log(`window short: ${armsRun.sessions.length} eligible sessions, need ${MIN_SESSIONS}`);
    process.exit(3);
  }
  const { pool, sample } = buildPool(armsRun.rows);
  const cwd = path.join(outDir, 'labeller-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  for (const model of ['sonnet', 'opus']) {
    if (!isolationOk(model, cwd)) { console.log(`isolation check failed for ${model}`); process.exit(5); }
  }
  if (!tune) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    try {
      // 'wx' makes the create atomic, so two concurrent runs cannot both pass.
      fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString(), freeze: build.sha }, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      console.log('refused: marker exists, a rerun needs a committed prereg amendment');
      process.exit(4);
    }
  }
  // Held-out memory text reaches disk only once the run is committed.
  fs.writeFileSync(path.join(outDir, 'arms.json'), JSON.stringify(armsRun, null, 1));
  fs.writeFileSync(path.join(outDir, 'pool.json'), JSON.stringify({ pool, sample }, null, 1));
  const opus = label('opus', pool, cwd);
  const sonnet = label('sonnet', pool.filter((p) => sample.includes(p.id)), cwd);
  const dump = (l) => (l ? Object.fromEntries(l) : null);
  // Labels are persisted because the stopping rule forbids a second labelling pass.
  fs.writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify({ opus: dump(opus.labels), sonnet: dump(sonnet.labels) }, null, 1));
  const resultFile = path.join(outDir, tune ? 'tune-result.json' : 'result.json');
  if (!opus.labels || !sonnet.labels) {
    fs.writeFileSync(resultFile, JSON.stringify({ verdict: 'VOID', reason: 'labelling incomplete after retry' }, null, 2));
    console.log('VOID: labelling incomplete after retry');
    process.exit(6);
  }
  const result = { mode: counts.mode, freeze: build.sha, ...score(armsRun, pool, sample, opus.labels, sonnet.labels) };
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
