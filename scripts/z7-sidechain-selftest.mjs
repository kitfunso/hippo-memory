// Offline synthetic cases for z7-sidechain-lib.mjs; run through the eval script's selftest command.
import * as L from './z7-sidechain-lib.mjs';

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
    AS([TU('Write', { file_path: 'C:\\repo\\src\\memory.ts', content: 'code' })]),
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
  const g = L.gateResults({ isolation: true, parse: { sonnet: [19, 20], opus: [20, 20], recheck: [0, 0] }, evidenceFail: { sonnet: [3, 10], opus: [4, 10] }, control: [1, 10], unplanted: [4, 20], planted: [17, 20] });
  t('gates: G2 95%, G3 30%, G4 10%, G5 15%, G6 85%, empty is untested', g.G2.sonnet === true && g.G2.recheck === null && g.G3.sonnet === true && g.G3.opus === false && g.G4 === true && g.G5 === false && g.G6 === true && !L.gatesValid(g));
  const J = { [SONNET]: { i1: { ok: true, returned: 1, failed: 0, verified: [{ kind: 'error', text: 'a', evidence: 'e', inReport: true }] } }, [OPUS]: { i1: { ok: true, returned: 1, failed: 0, verified: [{ kind: 'error', text: 'b', evidence: 'e', inReport: false }] } } };
  const R = { i1: { keptKeys: [`${OPUS}:0`], callsTotal: 1, callsOk: 1, decoy: 'planted', decoyKept: true } };
  const f = L.figures([{ id: 'i1', session: 's', agentType: 'worker', cut: false }], J, R);
  t('figures: a kept lesson removes consensus but not the union', f.pBefore === 1 && f.consensus === 0 && f.union === 1 && f.overturned === 1 && f.planted.join() === '1,1');
}


export const libSelftests = [selftestSub, selftestParent, selftestEvidence, selftestDrawAndChunks, selftestStats];
