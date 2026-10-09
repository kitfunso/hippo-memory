// Offline synthetic cases for z7-sidechain-lib.mjs; run through the eval script's selftest command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './z7-sidechain-lib.mjs';
import { git, guardScored, createMarker, startResume, countResumes, resumesLog, refuseApiKey } from './z7-sidechain-guard.mjs';

const [SONNET, OPUS] = L.MODELS;
const jl = (entries, extraLines = []) => [...entries.map((e) => JSON.stringify(e)), ...extraLines].join('\n');
const U = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const AS = (blocks, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra });
const T = (text) => ({ type: 'text', text });
const TU = (name, input, id = 'tu') => ({ type: 'tool_use', id, name, input });
const TR = (content, extra = {}) => ({ type: 'tool_result', tool_use_id: 'x', content, ...extra });

function selftestSub(t) {
  const fork = jl([
    U('parent context'), AS([T('old parent text')]),
    U([TR(''), T('<fork-boilerplate>\nrules\n</fork-boilerplate>\nDo the forked thing')]), AS([T('forked work')]),
  ]);
  const f = L.readSubAgent(fork, { isFork: true });
  t('fork prefix skipped, task after boilerplate', f.task === 'Do the forked thing' && f.items.length === 1 && f.items[0].text === 'forked work');
  const noise = L.readSubAgent(jl([
    U('the task'), U('peer says hi', { isMeta: true }), U('summary text', { isCompactSummary: true }), U([T('sneaky user text')]),
    U([TR('fine')]), AS([T('real work')]),
  ]), {});
  t('isMeta, compaction summaries and user text blocks skipped', noise.items.map((i) => i.text).join('|') === 'real work' && noise.task === 'the task');
  const multi = L.readSubAgent(jl([
    U('task'), AS([T('first report')]), U('resume please', { isMeta: true, origin: { kind: 'coordinator' } }),
    AS([TU('Bash', { command: 'ls' })]), U([TR('ok')]), AS([T('final one')]), AS([T('final two')]),
  ]), {});
  t('multi-turn reports', multi.reports.length === 2 && multi.reports[0] === 'first report' && multi.reports[1] === 'final one\nfinal two');
  const cut = L.readSubAgent(jl([U('task'), AS([T('narration')]), AS([TU('Bash', { command: 'ls' })])]), {});
  t('file cut off mid tool call has no report', cut.reports.length === 0 && cut.items.length === 1);
  const errs = L.readSubAgent(jl([
    U('task'), U([TR('boom '.repeat(200), { is_error: true })]), U([TR('fine result')]),
    ...Array.from({ length: 25 }, (_, i) => U([TR(`e${i}`, { is_error: true })])), AS([T('done')]),
  ]), {});
  const eItems = errs.items.filter((i) => i.kind === 'error');
  t('errored results rendered, 500 chars, at most 20', eItems.length === 20 && eItems[0].text.length === 500 && errs.errorsTotal === 26);
  t('[error] and [report] marks in B', /\[error\]\nboom/.test(L.renderB(errs.items).B) && L.renderB(errs.items).B.includes('[report]\ndone'));
  const saves = L.readSubAgent(jl([
    U('task'),
    AS([TU('Bash', { command: 'hippo remember "bash lesson"' })]), AS([TU('PowerShell', { command: 'hippo remember "ps lesson"' })]),
    AS([TU('Write', { file_path: 'C:\\Users\\x\\.claude\\projects\\p\\memory\\note.md', content: 'memory write' })]),
    AS([TU('Write', { file_path: 'C:\\repo\\src\\core\\memory.ts', content: 'code' })]),
    AS([TU('Edit', { file_path: '/r/CLAUDE.md', new_string: 'claude edit' })]),
  ]), {});
  t('own saves found, source file not', saves.saves.length === 4 && !saves.saves.includes('code'));
  const ord = L.readSubAgent(jl([U('task', { timestamp: '2026-09-02T10:00:00Z' }), AS([T('x')], { timestamp: '2026-09-02T09:00:00Z' })]), {});
  t('out-of-order timestamps flagged', ord.ordered === false);
  const badLine = L.readSubAgent(jl([U('task'), AS([T('kept')])], ['{not json']), {});
  t('one bad line skipped and counted', badLine.bad === 1 && badLine.items.length === 1);
  t('stripForkPrefix', L.stripForkPrefix(fork).includes('forked work') && !L.stripForkPrefix(fork).includes('old parent text'));
}

function selftestParent(t) {
  const report = 'Report body one that is quite specific and long enough to be unique among all the other text in this synthetic parent transcript.';
  const short = 'tiny report';
  const parent = jl([
    U('start the work'), AS([TU('Agent', { prompt: 'brief text', description: 'd' }, 'toolu_a')]),
    U([TR([{ type: 'text', text: `agentId: a1\n${report}` }], { tool_use_id: 'toolu_a' })]),
    AS([T('parent reacts to report')]), AS([TU('Bash', { command: 'ls' })]), AS([T('still same turn')]),
    U('next human message'), AS([T('later text')]),
    AS([TU('Agent', { prompt: 'second brief' }, 'toolu_b')]), U('<task-notification>\n<result>tiny report</result>\n</task-notification>', { promptSource: 'system' }),
    AS([T('reacts to short')]), U('human again'), AS([T('after human')]),
  ]);
  const pending = [
    { owner: 'a', toolUseId: 'toolu_a', prefix: L.reportPrefix(report), arrival: null },
    { owner: 'b', toolUseId: 'toolu_b', prefix: L.reportPrefix(short), arrival: null },
    { owner: 'c', toolUseId: 'toolu_a', prefix: L.reportPrefix('never appears anywhere'), arrival: null },
  ];
  const m = L.readParent(parent, pending);
  t('arrival found for a long and a short report, none for a missing one', pending[0].arrival !== null && pending[1].arrival !== null && pending[2].arrival === null);
  const w = L.buildWindows(m, [pending[0].arrival, pending[1].arrival]);
  t('window opens at arrival and stops at the next human message', w.windows.length === 2 && w.windows[0] === 'parent reacts to report\n\nstill same turn' && w.windows[1] === 'reacts to short');
  const big = jl([AS([TU('Agent', { prompt: 'p' }, 'toolu_z')]), U([TR('rep', { tool_use_id: 'toolu_z' })]), AS([T('x'.repeat(20000))])]);
  const p2 = [{ owner: 'z', toolUseId: 'toolu_z', prefix: 'rep', arrival: null }];
  const w2 = L.buildWindows(L.readParent(big, p2), [p2[0].arrival, p2[0].arrival]);
  t('windows cut to 8,000 each and 16,000 in all', w2.windows.length === 2 && w2.windows[0].length === 8000 && w2.windows[1].length === 8000 && w2.cut === 2);
  t('parent stream holds briefs and saves in order', m.stream.some((s) => s.kind === 'brief' && s.text === 'brief text'));
  const cs = U('summary\n10. Memories for hippo:\n   - lesson kept by hand\n11. Next section\nother', { isCompactSummary: true });
  const withCompact = L.readParent(jl([cs]), []);
  t('compaction "Memories for hippo" section kept, next section not', withCompact.stream.length === 1 && withCompact.stream[0].text.includes('lesson kept by hand') && !withCompact.stream[0].text.includes('Next section'));
  t('inline mention of the section name is not a section', L.memoriesSection('we print the "Memories for hippo" block in prose') === '');
}

function selftestEvidence(t) {
  const A = 'the task asks for something about alpha beta gamma delta epsilon zeta eta';
  const B = `work notes\n[report]\nthe loader   never reads Config files before the "hooks" run\n\n[error]\nstack trace words one two three four five six`;
  const lessons = [
    { kind: 'gotcha', text: 'a', evidence: 'never reads config' },
    { kind: 'gotcha', text: 'b', evidence: 'The loader never reads CONFIG files before the hooks run' },
    { kind: 'gotcha', text: 'c', evidence: 'alpha beta gamma delta epsilon zeta' },
    { kind: 'gotcha', text: 'd', evidence: 'work notes [report] the loader never reads' },
    { kind: 'gotcha', text: 'e', evidence: 'notes the loader never reads' },
    { kind: 'gotcha', text: 'f', evidence: 'run stack trace words one two' },
  ];
  const r = L.verifyLessons(lessons, A, B);
  t('evidence: 5 words rejected, 6 accepted, case and whitespace ignored', !r.kept.some((l) => l.text === 'a') && r.kept.some((l) => l.text === 'b'));
  t('evidence: in A rejected', !r.kept.some((l) => l.text === 'c'));
  t('evidence: spanning a removed mark rejected', !r.kept.some((l) => ['d', 'e', 'f'].includes(l.text)));
  t('evidence: mark text itself rejected', !L.verifyLessons([{ kind: 'gotcha', text: 'g', evidence: '[report] the loader never reads config files' }], A, B).kept.length);
}

function selftestDrawAndChunks(t) {
  const items = [];
  for (let s = 0; s < 20; s++) for (let k = 0; k < 7; k++) items.push({ session: `s${String(s).padStart(2, '0')}`, file: `agent-${k}.jsonl`, template: `tpl${k % 5}` });
  const d1 = L.drawSplit(items), d2 = L.drawSplit(items);
  t('draw deterministic', JSON.stringify(d1) === JSON.stringify(d2));
  const per = new Map();
  for (const it of [...d1.dev, ...d1.scored]) per.set(it.session, [...(per.get(it.session) ?? []), it.template]);
  t('draw caps: 3 per session, one per template', [...per.values()].every((ts) => ts.length <= 3 && new Set(ts).size === ts.length));
  const devSet = new Set(d1.devSessions);
  t('dev is 12 sessions, at most 24 items, disjoint from scored', d1.devSessions.length === 12 && d1.dev.length <= 24 && d1.dev.every((i) => devSet.has(i.session)) && d1.scored.every((i) => !devSet.has(i.session)));
  t('chunker boundary at 150,000', L.chunkSegments(['a'.repeat(150000)]).length === 1 && L.chunkSegments(['a'.repeat(150001)]).length === 2);
  const many = L.chunkSegments(Array.from({ length: 40 }, () => 'z'.repeat(9000)));
  t('chunks never exceed the limit and keep every character', many.every((c) => c.length <= 150000) && many.join('').replaceAll('\n\n', '').length === 360000);
  const pool = [
    { id: 'p1', session: 's1', project: 'alpha', lessons: [{ kind: 'error', text: 'same project lesson' }] },
    { id: 'p2', session: 's2', project: 'beta', lessons: [{ kind: 'error', text: 'beta error' }, { kind: 'gotcha', text: 'beta gotcha' }] },
  ];
  const subject = { id: 'me', session: 's9', project: 'alpha', kinds: ['error'] };
  const pick = L.pickDecoy(pool, subject, L.rngFromString('x'));
  t('decoy from a different project, different kind, unflagged', pick.lesson.text === 'beta gotcha' && pick.flag === null);
  const only = L.pickDecoy([pool[0]], { id: 'me', session: 's9', project: 'alpha', kinds: [] }, L.rngFromString('x'));
  t('decoy falls back to another session and says so', only.flag === 'other-session' && L.pickDecoy([pool[0]], { id: 'p1', session: 's1', project: 'alpha', kinds: [] }, L.rngFromString('x')) === null);
  const base = Array.from({ length: 3 }, (_, i) => `chunk${i} line a\nchunk${i} line b`);
  const planted = L.plantDecoy(base, 'PLANTED SENTENCE', L.rngFromString('seed'));
  t('planted text lands in exactly one chunk, once', planted.chunks.join('\n').split('PLANTED SENTENCE').length === 2 && planted.chunks.filter((c) => c.includes('PLANTED SENTENCE')).length === 1);
  const rl = L.recheckList([{ src: 'm', k: 0, kind: 'error', text: 'r' }], { kind: 'gotcha', text: 'd' }, L.rngFromString('q'));
  t('recheck list carries one decoy', rl.list.length === 2 && rl.list[rl.decoyIdx].src === 'decoy');
  t('working project strips home, -wt- and -worktree', L.workingProject({ 'C:\\Users\\k\\hippo-wt-z7gap\\src': 1 }, 'C:\\Users\\k') === 'hippo' && L.workingProject({ 'C:\\Users\\k\\foo-worktree-a': 2, 'C:\\Users\\k\\bar': 1 }, 'C:\\Users\\k') === 'foo');
  const rb = L.renderB([{ kind: 'text', text: 'S'.repeat(30000), reportId: 0 }, { kind: 'text', text: 'T'.repeat(30000), reportId: 1 }]);
  t('B cut keeps start and end, marks cut chars, ranges point at report text', rb.B.length <= 40000 && rb.cutChars > 0 && rb.B.startsWith('[report]\nSSS') && rb.B.endsWith('TTT') && rb.ranges.every(([s, e]) => /^(S+|T+)$/.test(rb.B.slice(s, e))));
}

function selftestStats(t) {
  const rows = Array.from({ length: 60 }, (_, i) => ({ cluster: `c${i % 12}`, hit: i % 4 === 0 }));
  const b1 = L.clusterBootstrap(rows), b2 = L.clusterBootstrap(rows);
  t('bootstrap deterministic and brackets p', JSON.stringify(b1) === JSON.stringify(b2) && b1.lo <= b1.p && b1.p <= b1.hi && b1.clusters === 12);
  t('kappa perfect and chance', L.cohenKappa([true, false, true, false], [true, false, true, false]) === 1 && L.cohenKappa([true, true], [true, true]) === null);
  const v = (lo, hi, uhi, ok = true) => L.verdict({ lo, hi }, { hi: uhi }, ok);
  t('verdict boundaries', v(0.2, 0.4, 0.4) === 'BUILD' && v(0.1999, 0.4, 0.4) === 'INCONCLUSIVE' && v(0, 0.0999, 0.0999) === 'DROP'
    && v(0, 0.0999, 0.1) === 'INCONCLUSIVE' && v(0, 0.1, 0.05) === 'INCONCLUSIVE' && v(0.3, 0.5, 0.5, false) === 'INVALID');
  t('parsers: fenced JSON, kind coercion, kept range', L.parseLessons('```json\n{"lessons":[{"kind":"Error","text":"x","evidence":"y"},{"kind":"bad","text":"z","evidence":"w"}]}\n```').lessons.map((l) => l.kind).join() === 'error,other'
    && !L.parseLessons('nope').ok && L.parseKept('{"kept":[0,5,1,1]}', 3).kept.join() === '0,1');
  const g = L.gateResults({ isolation: true, parse: { sonnet: [19, 20], opus: [20, 20], recheck: [0, 0] }, evidenceFail: { sonnet: [3, 10], opus: [4, 10] }, control: { total: 10, parsed: 10, hits: 1, parse: { sonnet: [10, 10], opus: [10, 10] } }, unplanted: [4, 20], planted: [17, 20] });
  t('gates: G2 95%, G3 30%, G4 10%, G5 15%, G6 85%, empty is untested', g.G2.sonnet === true && g.G2.recheck === null && g.G3.sonnet === true && g.G3.opus === false && g.G4 === true && g.G5 === false && g.G6 === true && !L.gatesValid(g));
  const J = { [SONNET]: { i1: { ok: true, returned: 1, failed: 0, verified: [{ kind: 'error', text: 'a', evidence: 'e', inReport: true }] } }, [OPUS]: { i1: { ok: true, returned: 1, failed: 0, verified: [{ kind: 'error', text: 'b', evidence: 'e', inReport: false }] } } };
  const R = { i1: { keptKeys: [`${OPUS}:0`], callsTotal: 1, callsOk: 1, decoy: 'planted', decoyKept: true } };
  const f = L.figures([{ id: 'i1', session: 's', agentType: 'worker', cut: false }], J, R);
  t('figures: a kept lesson removes consensus but not the union', f.pBefore === 1 && f.consensus === 0 && f.union === 1 && f.overturned === 1 && f.planted.join() === '1,1');
}

const hex = (c) => c.repeat(64);
export function pinsBlock(dist, prompts, claude = '2.1.288') {
  const named = (names, map) => names.map((n) => `\`${n}\` \`${map[n]}\``).join(', ');
  return ['## Pins', '', `- \`dist/\` SHA-256: ${named(L.PIN_DIST, dist)}.`, `- Snapshot manifest SHA-256 \`${hex('a')}\`; scored item list SHA-256 \`${hex('b')}\`.`,
    `- \`claude --version\`: ${claude}.`, `- Prompts SHA-256: ${named(L.PIN_PROMPTS, prompts)}.`].join('\n');
}

function selftestFrozen(t) {
  const dist = Object.fromEntries(L.PIN_DIST.map((n, i) => [n, hex(String(i + 1))]));
  const prompts = Object.fromEntries(L.PIN_PROMPTS.map((n, i) => [n, hex('cdef'[i])]));
  const md = `# x\n\n## Earlier\n\n- \`other.js\` \`${hex('9')}\`\n\n${pinsBlock(dist, prompts)}\n\n## Later\n\n- \`late.txt\` \`${hex('8')}\`\n`;
  const pins = L.parsePins(md);
  t('pins parsed from a synthetic block, other sections ignored', JSON.stringify(pins.dist) === JSON.stringify(dist) && JSON.stringify(pins.prompts) === JSON.stringify(prompts)
    && pins.manifest === hex('a') && pins.scoredList === hex('b') && pins.claude === '2.1.288');
  const ok = { dist, prompts, claude: '2.1.288 (Claude Code)' };
  t('pins match, and the claude version token is compared exactly', L.checkPins(pins, ok).length === 0 && ['2.1.2880', '2.1.288-dev', '2.1', 'v2.1.288'].every((v) => L.checkPins(pins, { claude: v }).length === 1) && L.checkPins(pins, { claude: '2.1.288\n' }).length === 0 && L.checkPins(pins, { manifest: hex('a'), scoredList: hex('b') }).length === 0);
  const bad = L.checkPins(pins, { dist: { ...dist, 'capture.js': hex('0') }, prompts: { ...prompts, 'judge-prompt.txt': undefined }, claude: '2.1.289', manifest: hex('0') });
  t('pin mismatches are named', bad.join() === 'dist/capture.js,judge-prompt.txt,manifest,claude --version');
  t('a missing pin is a mismatch', L.checkPins(L.parsePins('no pins here'), ok).length === 8 && L.checkPins(L.parsePins(md), { scoredList: undefined }).join() === 'scoredList');
}

function selftestDrawPinned(t) {
  const items = [];
  for (let s = 0; s < 20; s++) for (let k = 0; k < 7; k++) items.push({ session: `s${s}`, file: `agent-${k}.jsonl`, template: `tpl${k % 5}`, agentType: 'worker', project: 'p' });
  const fresh = L.buildDraw(items);
  const copy = () => JSON.parse(JSON.stringify(fresh));
  const pin = fresh.itemListSha256;
  t('a matching draw.json passes against the recomputed draw and the pin', L.drawMismatch(fresh, copy(), pin) === null);
  const swapped = copy();
  swapped.scored.reverse();
  const remapped = copy();
  remapped.items[fresh.scored[0]].project = 'other';
  const redev = copy();
  redev.dev.pop();
  t('draw refused: scored list, items mapping, dev list', /scored list/.test(L.drawMismatch(fresh, swapped, pin)) && /items mapping/.test(L.drawMismatch(fresh, remapped, pin)) && /dev list/.test(L.drawMismatch(fresh, redev, pin)));
  const mapped = copy();
  mapped.items[fresh.dev[0]].agentType = 'other';
  const extra = copy();
  extra.items.zz = { session: 'zz' };
  const counted = copy();
  counted.eligibleSubs += 1;
  t('draw refused: a dev mapping, an extra id, any other field', /items mapping differs/.test(L.drawMismatch(fresh, mapped, pin)) && /different set of ids/.test(L.drawMismatch(fresh, extra, pin)) && /eligibleSubs/.test(L.drawMismatch(fresh, counted, pin)));
  t('draw refused when the list sha256 differs from the pin', /prereg pin/.test(L.drawMismatch(fresh, copy(), hex('c'))));
}

function selftestControlAndAudit(t) {
  const ids = Array.from({ length: 30 }, (_, i) => `i${i}`);
  const mk = (okN, hitN) => Object.fromEntries(ids.map((id, i) => [id, { ok: i < okN, verified: i < hitN ? [{ kind: 'error', text: 'x' }] : [] }]));
  const c = L.controlFigures({ [SONNET]: mk(30, 0), [OPUS]: mk(26, 0) }, ids);
  t('control counts: per-judge parse and items parsed by both', c.total === 30 && c.parsed === 26 && c.parse.sonnet.join() === '30,30' && c.parse.opus.join() === '26,30');
  const gates = (primary, control) => L.gateResults({ isolation: true, parse: { ...primary, recheck: [1, 1] }, evidenceFail: { sonnet: [0, 1], opus: [0, 1] }, control, unplanted: [0, 1], planted: [1, 1] });
  const ctl = (parsed, hits, parse = { sonnet: [30, 30], opus: [30, 30] }) => ({ total: 30, parsed, hits, parse });
  const primary = { sonnet: [19, 20], opus: [20, 20] };
  t('G4 false when under 27 of 30 parsed, else hits over parsed', gates(primary, ctl(26, 0)).G4 === false && gates(primary, ctl(27, 2)).G4 === true && gates(primary, ctl(27, 3)).G4 === false && gates(primary, ctl(30, 3)).G4 === true && gates(primary, ctl(30, 4)).G4 === false);
  t('G2 counts control calls with the primary calls per judge', gates(primary, ctl(30, 0)).G2.sonnet === true && gates(primary, ctl(30, 0, { sonnet: [0, 10], opus: [10, 10] })).G2.sonnet === false);
  const fin = (v, n, k) => L.finalizeAudit(v, n, k).final;
  t('audit finalize at the 0.75 boundary', fin('BUILD', 4, 3) === 'BUILD' && fin('BUILD', 10, 7) === 'INCONCLUSIVE' && fin('BUILD', 10, 8) === 'BUILD' && fin('BUILD', 3, 2) === 'INCONCLUSIVE' && fin('BUILD', 3, 3) === 'BUILD');
  t('audit finalize leaves other verdicts unchanged and reports the share', fin('DROP', 10, 0) === 'DROP' && fin('INCONCLUSIVE', 10, 0) === 'INCONCLUSIVE' && fin('INVALID', 10, 10) === 'INVALID' && L.finalizeAudit('BUILD', 8, 6).share === 0.75);
}

function selftestGuard(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z7-guard-'));
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'z7-dist-'));
  const G = (...args) => { const r = git(dir, args); if (r.status !== 0) throw new Error(r.stderr); return r; };
  const body = (kind, n) => `${kind} ${n}`;
  const cfg = {
    repo: dir, prereg: path.join(dir, 'prereg.md'), scriptFiles: [path.join(dir, 'a.mjs'), path.join(dir, 'b.mjs')], promptDir: path.join(dir, 'prompts'),
    distDir, claudeVersion: () => '2.1.288 (Claude Code)', lockDir: path.join(dir, 'locks'),
  };
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  const refuses = (re, resume = false) => throws(() => guardScored(cfg, resume), re);
  const commit = (msg) => { G('add', '-A'); G('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg); };
  const hashes = (names, kind) => Object.fromEntries(names.map((n) => [n, L.sha256(body(kind, n))]));
  const prereg = (status) => `**Date:** x. **Status:** ${status}\n\n${pinsBlock(hashes(L.PIN_DIST, 'dist'), hashes(L.PIN_PROMPTS, 'prompt'))}\n`;
  try {
    G('init', '-q');
    fs.mkdirSync(cfg.promptDir);
    for (const n of L.PIN_PROMPTS) fs.writeFileSync(path.join(cfg.promptDir, n), body('prompt', n));
    for (const n of L.PIN_DIST) fs.writeFileSync(path.join(distDir, n), body('dist', n));
    for (const f of cfg.scriptFiles) fs.writeFileSync(f, 'export {};\n');
    fs.writeFileSync(cfg.prereg, prereg('PRE-REG-LOCKED.'));
    t('guard refuses an untracked prereg', refuses(/not tracked/));
    fs.writeFileSync(cfg.prereg, prereg('DRAFT. It locks at the commit that sets this line to PRE-REG-LOCKED.'));
    commit('draft');
    t('guard refuses a DRAFT status, even when the line names PRE-REG-LOCKED', refuses(/PRE-REG-LOCKED/));
    fs.writeFileSync(cfg.prereg, prereg('PRE-REG-LOCKED.'));
    commit('lock');
    t('guard refuses a lock commit on no remote branch', refuses(/remote branch/));
    G('update-ref', 'refs/remotes/origin/test', 'HEAD');
    t('guard passes when everything holds', !refuses(/./) && guardScored(cfg).lockCommit.length === 40);
    fs.writeFileSync(cfg.scriptFiles[0], 'export const x = 1;\n');
    t('guard refuses a dirty script', refuses(/not clean/));
    G('checkout', '--', 'a.mjs');
    fs.writeFileSync(path.join(cfg.promptDir, 'new.txt'), 'untracked prompt');
    t('guard refuses an untracked prompt file', refuses(/prompt file is not tracked/));
    fs.rmSync(path.join(cfg.promptDir, 'new.txt'));
    fs.writeFileSync(path.join(distDir, 'capture.js'), 'edited build');
    t('guard refuses a dist pin mismatch', refuses(/pin mismatch: dist\/capture\.js/));
    fs.writeFileSync(path.join(distDir, 'capture.js'), body('dist', 'capture.js'));
    for (const v of ['9.9.9', '2.1.2880', '2.1.288-dev']) {
      cfg.claudeVersion = () => v;
      t(`guard refuses claude ${v}`, refuses(/claude --version/));
    }
    cfg.claudeVersion = () => '2.1.288 (Claude Code)';
    fs.writeFileSync(cfg.scriptFiles[0], 'export const x = 1;\n');
    commit('later change');
    t('guard refuses a script that changed after the lock commit, even when committed', refuses(/after the lock commit: a\.mjs/));
    fs.appendFileSync(cfg.prereg, '\nA later note.\n');
    commit('prereg edit after the script change');
    t('a later prereg edit does not move the lock commit', refuses(/after the lock commit: .*a\.mjs/));
    fs.writeFileSync(cfg.scriptFiles[0], 'export {};\n');
    commit('restore script');
    t('guard refuses a prereg body edit that keeps Status locked, naming the prereg', refuses(/after the lock commit: prereg\.md$/));
    fs.writeFileSync(cfg.prereg, prereg('PRE-REG-LOCKED.'));
    commit('restore prereg');
    const lock = guardScored(cfg);
    t('resume refused without a marker', refuses(/no lock marker/, true));
    createMarker(lock, 'abc');
    t('guard refuses once the marker exists, and the marker is create-once', refuses(/marker exists/) && throws(() => createMarker(lock, 'abc'), /EEXIST/));
    const sdir = path.join(dir, 'scored');
    fs.mkdirSync(sdir);
    t('resume guard passes with a marker', !refuses(/./, true));
    t('resume refused for another lock commit', throws(() => startResume({ ...lock, lockCommit: 'f'.repeat(40) }, 'abc', sdir), /different lock commit/));
    t('resume refused for another item list', throws(() => startResume(lock, 'other', sdir), /item list/));
    startResume(lock, 'abc', sdir);
    t('resume accepted and logged', countResumes(lock) === 1 && JSON.parse(fs.readFileSync(resumesLog(lock), 'utf8').trim()).lockCommit === lock.lockCommit);
    fs.writeFileSync(path.join(sdir, 'result.json'), '{}');
    t('resume refused once result.json exists', throws(() => startResume(lock, 'abc', sdir), /finished/));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  t('ANTHROPIC_API_KEY refusal', throws(() => refuseApiKey({ ANTHROPIC_API_KEY: 'x' }), /ANTHROPIC_API_KEY/) && refuseApiKey({}) === undefined);
}

export const libSelftests = [selftestSub, selftestParent, selftestEvidence, selftestDrawAndChunks, selftestStats, selftestFrozen, selftestDrawPinned, selftestControlAndAudit, selftestGuard];
