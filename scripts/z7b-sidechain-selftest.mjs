// Offline synthetic cases for z7b-sidechain-lib.mjs; run through the Z7b eval script's selftest command, after Z7's own cases.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './z7-sidechain-lib.mjs';
import * as Z from './z7b-sidechain-lib.mjs';
import { git, guardScored, createMarker } from './z7-sidechain-guard.mjs';

const [SONNET, OPUS] = L.MODELS;
const hex = (c) => c.repeat(64);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

function selftestDraw(t) {
  const items = [];
  for (let s = 0; s < 40; s++) for (let k = 0; k < 18; k++) items.push({ session: `s${s}`, file: `agent-${k}.jsonl`, template: `t${k % 12}`, agentType: 'worker', project: 'p' });
  const z7 = L.buildDraw(items);
  const d = Z.buildDrawZ7b(items, z7);
  const byId = new Map(items.map((it) => [L.itemId(it.session, it.file), it]));
  const scored = d.scored.map((id) => byId.get(id));
  const devSet = new Set(d.dev);
  const devPairs = new Set(d.dev.map((id) => `${byId.get(id).session}|${byId.get(id).template}`));
  const perSession = new Map();
  for (const it of scored) perSession.set(it.session, (perSession.get(it.session) ?? 0) + 1);
  t('z7b draw: the dev set is Z7 dev plus Z7 scored, and no scored id is a dev id', d.dev.length === z7.dev.length + z7.scored.length && d.scored.length > 0 && d.scored.every((id) => !devSet.has(id)));
  t('z7b draw: a (session, template) pair of a dev item is never scored', scored.every((it) => !devPairs.has(`${it.session}|${it.template}`)));
  t('z7b draw: at most 5 per session, and the cap is reached', Math.max(...perSession.values()) === 5 && Z.SESSION_CAP === 5);
  t('z7b draw: one per (session, template)', new Set(scored.map((it) => `${it.session}|${it.template}`)).size === scored.length);
  t('z7b draw: deterministic, and the Z7 scored sha passes through', JSON.stringify(Z.buildDrawZ7b(items, z7)) === JSON.stringify(d) && d.z7ScoredSha256 === z7.itemListSha256);
  t('z7b draw: items map every dev and scored id, counts match', Object.keys(d.items).length === d.dev.length + d.scored.length && d.scoredSessions === perSession.size && d.itemListSha256 === L.sha256(d.scored.join('\n')));

  const pin = d.itemListSha256;
  const copy = () => JSON.parse(JSON.stringify(d));
  const swapped = copy();
  swapped.scored.reverse();
  const remapped = copy();
  remapped.items[d.scored[0]].project = 'other';
  t('z7b draw mismatch: equal passes; a changed scored list and a changed item mapping fail', Z.drawMismatchZ7b(d, copy(), pin) === null
    && /scored list/.test(Z.drawMismatchZ7b(d, swapped, pin)) && /items mapping/.test(Z.drawMismatchZ7b(d, remapped, pin)));
  t('z7b draw mismatch: a wrong pin and a null pin fail', /prereg pin/.test(Z.drawMismatchZ7b(d, copy(), hex('c'))) && /no scored list/.test(Z.drawMismatchZ7b(d, copy(), null)));

  const pins = { manifest: hex('a'), scoredList: pin, prompts: {}, dist: {} };
  const inp = { manifestSha: hex('a'), z7Fresh: z7, z7Stored: JSON.parse(JSON.stringify(z7)), fresh: d, stored: copy() };
  const run = (over, p = pins) => Z.checkDrawZ7b({ ...inp, ...over }, p, z7.itemListSha256);
  t('checkDrawZ7b: a matching draw and pins pass', run({}) === null);
  t('checkDrawZ7b: a null scored-list pin refuses', /pin mismatch: scoredList/.test(run({}, { ...pins, scoredList: null })));
  t('checkDrawZ7b: a null or wrong manifest pin refuses', /pin mismatch: manifest/.test(run({}, { ...pins, manifest: null })) && /pin mismatch: manifest/.test(run({ manifestSha: hex('0') })));
  t('checkDrawZ7b: a changed Z7 dev list refuses, and so does a stored Z7b draw that differs', /Z7 dev set/.test(run({ z7Stored: { ...inp.z7Stored, dev: inp.z7Stored.dev.slice(1) } })) && /scored list/.test(run({ stored: swapped })));

  const runDev = (over) => Z.checkDevDrawZ7b({ ...inp, ...over }, z7.itemListSha256);
  const moved = copy();
  moved.dev.push(moved.scored.shift());
  t('checkDevDrawZ7b: a matching draw passes without pins', runDev({}) === null);
  t('checkDevDrawZ7b: an id moved from scored to dev refuses', /dev list|scored list/.test(runDev({ stored: moved })));
  t('checkDevDrawZ7b: a changed Z7 stored draw refuses', /Z7 dev set/.test(runDev({ z7Stored: { ...inp.z7Stored, dev: inp.z7Stored.dev.slice(1) } })));
  t('untestedGates: top-level and nested nulls are listed, dotted', JSON.stringify(Z.untestedGates({ G1: true, G4: null, G2: { sonnet: 1, recheck: null }, G3: { opus: null, filter: 2 } })) === JSON.stringify(['G4', 'G2.recheck', 'G3.opus']));
  t('untestedGates: nothing null gives an empty list', Z.untestedGates({ G1: true, G2: { a: 0, b: false } }).length === 0);
}

function selftestPrompts(t) {
  const names = Z.PIN_PROMPTS;
  const cur = Object.fromEntries(names.map((n, i) => [n, hex('0123'[i])]));
  const sc = () => ({ ...cur });
  t('prompt sha agree: equal sidecars and files pass', Z.promptShaAgree([sc(), sc(), sc()], cur, names));
  t('prompt sha agree: a prompt edited after the filter ran refuses', !Z.promptShaAgree([sc(), sc(), sc()], { ...cur, 'filter-prompt.txt': hex('f') }, names)
    && !Z.promptShaAgree([sc(), sc(), { ...cur, 'filter-prompt.txt': hex('f') }], cur, names));
  t('prompt sha agree: a missing sidecar or a missing name refuses', !Z.promptShaAgree([sc(), null, sc()], cur, names) && !Z.promptShaAgree([], cur, names)
    && !Z.promptShaAgree([{ ...cur, 'judge-system.txt': undefined }], cur, names));
  const pins = { prompts: { ...cur, 'unrelated.txt': hex('9') } };
  t('pins match prompts: an extra unrelated .txt pin does not fail', Z.pinsMatchPrompts(pins, cur, names));
  t('pins match prompts: a mismatched or missing named prompt fails', !Z.pinsMatchPrompts(pins, { ...cur, 'judge-prompt.txt': hex('e') }, names)
    && !Z.pinsMatchPrompts({ prompts: { 'judge-prompt.txt': cur['judge-prompt.txt'] } }, cur, names) && !Z.pinsMatchPrompts(pins, undefined, names));
}

function selftestFilter(t) {
  const reply = (labels) => JSON.stringify({ labels: labels.map((label, i) => ({ i, label })) });
  const ok = Z.parseFilter(reply(['keep', 'file', 'self']), 3);
  t('parseFilter: a valid reply, and a fenced one', ok.ok && ok.labels.join() === 'keep,file,self' && Z.parseFilter(`\`\`\`json\n${reply(['known'])}\n\`\`\``, 1).ok);
  const raw = (labels) => JSON.stringify({ labels });
  t('parseFilter: a missing index, a duplicate index and an extra index fail', !Z.parseFilter(raw([{ i: 0, label: 'keep' }]), 2).ok
    && !Z.parseFilter(raw([{ i: 0, label: 'keep' }, { i: 0, label: 'file' }]), 2).ok && !Z.parseFilter(raw([{ i: 0, label: 'keep' }, { i: 5, label: 'file' }]), 1).ok);
  t('parseFilter: an unknown label, a non-integer index and non-JSON fail', !Z.parseFilter(raw([{ i: 0, label: 'maybe' }]), 1).ok && !Z.parseFilter(raw([{ i: '0', label: 'keep' }]), 1).ok
    && !Z.parseFilter('no json here', 1).ok && !Z.parseFilter('{"lessons":[]}', 1).ok);

  const v = (...texts) => ({ ok: true, returned: texts.length, failed: 0, verified: texts.map((text) => ({ kind: 'gotcha', text, evidence: 'e', inReport: false })) });
  const judge = { [SONNET]: { a: v('s0', 's1'), b: v('s0') }, [OPUS]: { a: v('o0', 'o1'), b: v('o0') } };
  const recheck = { a: { keptKeys: [`${SONNET}:0`], callsTotal: 2, callsOk: 2, decoy: 'planted', decoyKept: false, flag: null, chunks: 2 }, b: { keptKeys: [], callsTotal: 1, callsOk: 1, decoy: 'unplanted', decoyKept: false } };
  const cands = Z.candidates(judge, recheck, 'a');
  t('candidates: a recheck-kept lesson is not a candidate, Sonnet first, each keeps the judge index', cands.map((c) => `${c.model}:${c.k}`).join() === `${SONNET}:1,${OPUS}:0,${OPUS}:1`);
  const parsed = Z.parseFilter(reply(['keep', 'file', 'result']), 3);
  t('removalKeys: every non-keep candidate, on the judge own index', Z.removalKeys(cands, parsed).join() === `${OPUS}:0,${OPUS}:1`);
  t('removalKeys: an unparsed filter removes nothing', Z.removalKeys(cands, { ok: false, labels: [] }).length === 0);

  const filter = { items: { a: { ok: true, n: 3, labels: ['keep', 'file', 'result'], removed: Z.removalKeys(cands, parsed) } } };
  const merged = Z.mergeRemovals(recheck, filter);
  t('mergeRemovals: appends keys and keeps every other field', merged.a.keptKeys.join() === `${SONNET}:0,${OPUS}:0,${OPUS}:1` && merged.a.callsTotal === 2 && merged.a.callsOk === 2
    && merged.a.decoy === 'planted' && merged.a.decoyKept === false && merged.a.chunks === 2);
  t('mergeRemovals: an id absent from the filter is unchanged, the input is not mutated', merged.b === recheck.b && recheck.a.keptKeys.length === 1);
  const st = Z.filterStats({ items: { a: filter.items.a, b: { ok: false, n: 1, labels: [], removed: [] } } });
  t('filterStats: parse counts and label counts from parsed items only', st.parse.join() === '1,2' && st.labels.keep === 1 && st.labels.file === 1 && st.labels.result === 1 && st.labels.self === 0);
}

function selftestFigures(t) {
  const lesson = (text) => ({ kind: 'gotcha', text, evidence: 'e', inReport: false });
  const J = (n) => ({ ok: true, returned: n, failed: 0, verified: Array.from({ length: n }, (_, i) => lesson(`l${i}`)) });
  const judge = { [SONNET]: { i1: J(1), i2: J(1), i3: J(1) }, [OPUS]: { i1: J(1), i2: J(1), i3: J(1) } };
  const rc = (keptKeys) => ({ keptKeys, callsTotal: 1, callsOk: 1, decoy: 'unplanted', decoyKept: false });
  const recheck = { i1: rc([]), i2: rc([`${OPUS}:0`]), i3: rc([]) };
  const filter = { items: { i1: { ok: true, n: 2, labels: ['file', 'file'], removed: [`${SONNET}:0`, `${OPUS}:0`] } } };
  const rows = ['i1', 'i2', 'i3'].map((id) => ({ id, session: 's', agentType: 'worker', cut: false }));
  const fUnf = L.figures(rows, judge, recheck);
  const fFil = L.figures(rows, judge, Z.mergeRemovals(recheck, filter));
  t('two-pass figures: overturned counts recheck keys only', fUnf.overturned === 1);
  t('two-pass figures: the unfiltered union still counts an item the filter emptied', fUnf.union === 3 && fUnf.consensus === 2);
  t('two-pass figures: the consensus drops an item whose only lessons were filter-removed', fFil.consensus === 1 && fFil.union === 2);
  t('two-pass figures: decoy and parse figures are the same in both passes', JSON.stringify([fUnf.parse, fUnf.unplanted, fUnf.planted]) === JSON.stringify([fFil.parse, fFil.unplanted, fFil.planted]));
}

function selftestGatesAndVerdict(t) {
  const f = { parse: { sonnet: [20, 20], opus: [20, 20], recheck: [5, 5] }, evidenceFail: { sonnet: [1, 10], opus: [1, 10] }, unplanted: [0, 3], planted: [3, 3] };
  const ctl = { total: 30, parsed: 30, hits: 0, parse: { sonnet: [30, 30], opus: [30, 30] } };
  t('gatesZ7b: filter parse at 94 of 100 fails the run', Z.gatesZ7b(f, true, ctl, [94, 100]).G2.filter === false && !L.gatesValid(Z.gatesZ7b(f, true, ctl, [94, 100])));
  t('gatesZ7b: 95 of 100 passes, and 0 calls is untested and does not fail', Z.gatesZ7b(f, true, ctl, [95, 100]).G2.filter === true && L.gatesValid(Z.gatesZ7b(f, true, ctl, [95, 100]))
    && Z.gatesZ7b(f, true, ctl, [0, 0]).G2.filter === null && L.gatesValid(Z.gatesZ7b(f, true, ctl, [0, 0])));
  t('gatesZ7b: the Z7 gates are still read from the unfiltered pass', Z.gatesZ7b({ ...f, planted: [0, 3] }, true, ctl, [1, 1]).G6 === false);
  const v = (uhi, ok = true) => Z.verdictZ7b({ lo: 0.3, hi: 0.5 }, { hi: uhi }, ok);
  t('verdictZ7b: INVALID, DROP below 0.10, PENDING_AUDIT at 0.10', v(0.2, false) === 'INVALID' && v(0.0999) === 'DROP' && v(0.1) === 'PENDING_AUDIT');
  const fin = (pre, lo, n, k) => Z.finalizeAuditZ7b(pre, { lo }, n, k);
  t('finalizeAuditZ7b: lo 0.134 with 9 of 12 is BUILD, lo 0.13 is INCONCLUSIVE', fin('PENDING_AUDIT', 0.134, 12, 9).final === 'BUILD' && fin('PENDING_AUDIT', 0.13, 12, 9).final === 'INCONCLUSIVE');
  t('finalizeAuditZ7b: a high lo with 8 of 12 is INCONCLUSIVE, and an empty audit is too', fin('PENDING_AUDIT', 0.3, 12, 8).final === 'INCONCLUSIVE' && fin('PENDING_AUDIT', 0.3, 0, 0).final === 'INCONCLUSIVE');
  t('finalizeAuditZ7b: strong needs lo 0.20 and 9 of 12', fin('PENDING_AUDIT', 0.2, 12, 9).strong && !fin('PENDING_AUDIT', 0.1999, 12, 9).strong && !fin('PENDING_AUDIT', 0.3, 12, 8).strong);
  t('finalizeAuditZ7b: DROP and INVALID are unchanged, share and adjusted lo are reported', fin('DROP', 0.3, 12, 12).final === 'DROP' && fin('INVALID', 0.3, 12, 12).final === 'INVALID'
    && fin('PENDING_AUDIT', 0.2, 12, 9).share === 0.75 && Math.abs(fin('PENDING_AUDIT', 0.2, 12, 9).adjustedLo - 0.15) < 1e-12);
}

function selftestSamples(t) {
  const ids = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const bear = ids('b', 30), rem = ids('r', 12);
  const a = Z.calibSamples(1, bear, rem, []);
  t('calibSamples: deterministic, capped at 12 and 8, drawn from the lists', JSON.stringify(a) === JSON.stringify(Z.calibSamples(1, bear, rem, [])) && a.precision.length === 12 && a.falsex.length === 8
    && a.precision.every((id) => bear.includes(id)) && a.falsex.every((id) => rem.includes(id)) && JSON.stringify(a) !== JSON.stringify(Z.calibSamples(2, bear, rem, [])));
  const prior = a.precision.slice(0, 5);
  const b = Z.calibSamples(2, bear, rem, prior);
  t('calibSamples: ids sampled before come last, so a list long enough avoids them', b.precision.every((id) => !prior.includes(id)));
  const short = Z.calibSamples(2, bear.slice(0, 14), rem.slice(0, 3), prior.filter((id) => bear.slice(0, 14).includes(id)));
  t('calibSamples: fewer ids than the cap gives fewer, prior ones still included last', short.falsex.length === 3 && short.precision.length === 12);
  const tiny = Z.calibSamples(1, ids('b', 4), [], []);
  t('calibSamples: a short or empty list gives a short or empty sample', tiny.precision.length === 4 && tiny.falsex.length === 0);
  const up = Z.calibSamples(1, ids('b', 8), rem, [], ids('u', 6));
  t('calibSamples: a top-up fills a short sample after every bearing id and leaves falsex alone',
    up.precision.length === 12 && up.precision.slice(0, 8).every((id) => id.startsWith('b')) && up.precision.slice(8).every((id) => id.startsWith('u'))
    && JSON.stringify(up.falsex) === JSON.stringify(Z.calibSamples(1, ids('b', 8), rem, []).falsex));
  t('calibSamples: a top-up is unused when the bearing list fills the sample', JSON.stringify(Z.calibSamples(1, bear, rem, [], ids('u', 6))) === JSON.stringify(a));

  const au = Z.auditSample(bear, rem);
  t('auditSample: 12 bearing plus 4 dropped in one list, deterministic', au.ids.length === 16 && au.bearing.length === 12 && au.dropped.length === 4 && JSON.stringify(au) === JSON.stringify(Z.auditSample(bear, rem))
    && new Set(au.ids).size === 16 && au.dropped.every((id) => rem.includes(id)) && au.ids.join() !== [...au.bearing, ...au.dropped].join());
  const few = Z.auditSample(ids('b', 5), ids('r', 2));
  t('auditSample: fewer ids than the caps gives fewer', few.ids.length === 7 && few.bearing.length === 5 && few.dropped.length === 2);
}

function selftestMarks(t) {
  const sample = ['a', 'b', 'c'];
  const good = { a: 'confirmed', b: 'rejected:file', c: 'rejected:present' };
  t('checkMarks: a complete valid set passes', Z.checkMarks(good, sample) === null);
  t('checkMarks: a missing id, an extra id and a bad class each refuse', Z.checkMarks({ a: 'confirmed', b: 'confirmed' }, sample) !== null
    && Z.checkMarks({ ...good, d: 'confirmed' }, sample) !== null && Z.checkMarks({ ...good, c: 'rejected:bogus' }, sample) !== null);
  t('checkMarks: a bare rejected, an unknown word and a non-object refuse', Z.checkMarks({ ...good, c: 'rejected' }, sample) !== null && Z.checkMarks({ ...good, c: 'maybe' }, sample) !== null && Z.checkMarks([], sample) !== null);
  const marks = (n, k) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`i${i}`, i < k ? 'confirmed' : 'rejected:known']));
  t('calibPass: 9 of 12 passes, 8 of 12 fails, 9 of 9 fails for n under 10', Z.calibPass(marks(12, 9)) && !Z.calibPass(marks(12, 8)) && !Z.calibPass(marks(9, 9)) && Z.calibPass(marks(10, 8)));
  t('summariseMarks: counts and rejected classes', JSON.stringify(Z.summariseMarks(good)) === JSON.stringify({ n: 3, confirmed: 1, byClass: { file: 1, present: 1 } }));
}

function selftestPromptFiles(t) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (dir, n) => fs.readFileSync(path.join(here, dir, n), 'utf8');
  t('prompt dir holds exactly the four pinned prompts', fs.readdirSync(path.join(here, 'z7b-sidechain-prompts')).sort().join() === [...Z.PIN_PROMPTS].sort().join());
  // Amendment 2: from dev round 2 the judge prompt is Z7's too.
  t('judge-system, judge-prompt and recheck-prompt are byte-identical to Z7', ['judge-system.txt', 'judge-prompt.txt', 'recheck-prompt.txt'].every((n) => L.sha256(read('z7b-sidechain-prompts', n)) === L.sha256(read('z7-sidechain-prompts', n))));
  const filt = read('z7b-sidechain-prompts', 'filter-prompt.txt');
  t('filter prompt has the A, B and LESSONS slots and every label', ['{{A}}', '{{B}}', '{{LESSONS}}'].every((v) => filt.includes(v)) && !filt.includes('{{C}}') && Z.FILTER_LABELS.every((l) => filt.includes(`"${l}"`)));
}

function pinsBlock(prompts) {
  const named = Z.PIN_PROMPTS.map((n) => `\`${n}\` \`${prompts[n]}\``).join(', ');
  return ['## Pins', '', `- Snapshot manifest SHA-256 \`${hex('a')}\`; scored item list SHA-256 \`${hex('b')}\`.`, `- Prompts SHA-256: ${named}.`].join('\n');
}

// The Z7b guard config: its own marker name, its own prompt pins, a frozen check over the Z7b files.
function selftestGuard(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z7b-guard-'));
  const G = (...args) => { const r = git(dir, args); if (r.status !== 0) throw new Error(r.stderr); return r; };
  const commit = (msg) => { G('add', '-A'); G('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg); };
  const body = (n) => `prompt ${n}`;
  const right = Object.fromEntries(Z.PIN_PROMPTS.map((n) => [n, L.sha256(body(n))]));
  const cfg = {
    repo: dir, prereg: path.join(dir, 'prereg.md'), scriptFiles: ['z7b-sidechain-lib.mjs', 'z7b-sidechain-eval.mjs'].map((f) => path.join(dir, f)), promptDir: path.join(dir, 'prompts'),
    distDir: path.join(dir, 'dist'), claudeVersion: () => '2.1.288', lockDir: path.join(dir, 'locks'), lockName: Z.LOCK_NAME, pinPrompts: Z.PIN_PROMPTS,
  };
  const refuses = (re) => throws(() => guardScored(cfg), re);
  try {
    G('init', '-q');
    fs.mkdirSync(cfg.promptDir);
    fs.mkdirSync(cfg.distDir);
    for (const n of Z.PIN_PROMPTS) fs.writeFileSync(path.join(cfg.promptDir, n), body(n));
    for (const f of cfg.scriptFiles) fs.writeFileSync(f, 'export {};\n');
    const dist = Object.fromEntries(L.PIN_DIST.map((n) => [n, L.sha256(`dist ${n}`)]));
    for (const n of L.PIN_DIST) fs.writeFileSync(path.join(cfg.distDir, n), `dist ${n}`);
    const distLine = `- \`dist/\` SHA-256: ${L.PIN_DIST.map((n) => `\`${n}\` \`${dist[n]}\``).join(', ')}.\n- \`claude --version\`: 2.1.288.`;
    const prereg = (pins) => `**Date:** x. **Status:** PRE-REG-LOCKED.\n\n${pinsBlock(pins)}\n${distLine}\n`;
    fs.writeFileSync(cfg.prereg, prereg({ ...right, 'filter-prompt.txt': hex('0') }));
    commit('lock with a wrong filter pin');
    G('update-ref', 'refs/remotes/origin/test', 'HEAD');
    t('z7b guard: the filter prompt is pinned, and a wrong pin is named', refuses(/pin mismatch: filter-prompt\.txt$/));
    fs.writeFileSync(cfg.prereg, prereg(right));
    commit('fix the pin');
    t('z7b guard: a prereg edit after the lock commit refuses', refuses(/after the lock commit: prereg\.md/));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'z7b-guard2-'));
    try {
      const G2 = (...args) => { const r = git(dir2, args); if (r.status !== 0) throw new Error(r.stderr); return r; };
      const cfg2 = { ...cfg, repo: dir2, prereg: path.join(dir2, 'prereg.md'), scriptFiles: cfg.scriptFiles.map((f) => path.join(dir2, path.basename(f))), promptDir: path.join(dir2, 'prompts'), lockDir: path.join(dir2, 'locks') };
      G2('init', '-q');
      fs.mkdirSync(cfg2.promptDir);
      for (const n of Z.PIN_PROMPTS) fs.writeFileSync(path.join(cfg2.promptDir, n), body(n));
      for (const f of cfg2.scriptFiles) fs.writeFileSync(f, 'export {};\n');
      fs.writeFileSync(cfg2.prereg, prereg(right));
      G2('add', '-A');
      G2('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'lock');
      G2('update-ref', 'refs/remotes/origin/test', 'HEAD');
      const lock = guardScored(cfg2);
      t('z7b guard: passes with the four Z7b prompt pins and no rule-arm prompt', lock.lockCommit.length === 40);
      t('z7b guard: the marker is z7b-sidechain-strict.json and is create-once', path.basename(lock.marker) === 'z7b-sidechain-strict.json' && (createMarker(lock, 'abc'), fs.existsSync(lock.marker)) && throws(() => createMarker(lock, 'abc'), /EEXIST/));
      fs.writeFileSync(cfg2.scriptFiles[0], 'export const x = 1;\n');
      G2('add', '-A');
      G2('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'later change');
      t('z7b guard: a changed z7b script fails the frozen check even when committed', throws(() => guardScored(cfg2, true), /after the lock commit: z7b-sidechain-lib\.mjs/));
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const z7bSelftests = [selftestDraw, selftestPrompts, selftestFilter, selftestFigures, selftestGatesAndVerdict, selftestSamples, selftestMarks, selftestPromptFiles, selftestGuard];
