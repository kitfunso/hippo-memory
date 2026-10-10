// The Z6 --selftest: checks the committed fixture, the labeller and the output parsers; spawns nothing and writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { hasWord, norm, sentences, TUNE, assignSplit, fixtureId, STOP, fixtureProblems } from './fixture.mjs';
import {
  ARMS, wilson, computeValues, isRetired, captured, vanishedCause, carriersLost, addCauses, computeReach, chainReaches,
  reasonTest, contextShows, labelChange, labelControl, fillerCounts, fillerLostTotal, changeDiagnostics, computeVerdict,
} from './scoring.mjs';
import { rootBaseOk, dailyRunnerOk, parseWorkerLog, checkHooks, parseRankedIds, parseExplainBlocks } from './output-checks.mjs';

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

async function selftestQuestionReach(fx, check, distDir) {
  const search = await import(pathToFileURL(path.join(distDir, 'util/tokenize.js')).href);
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

async function selftest(fixturePath, distDir) {
  let n = 0;
  const check = (cond, msg) => { n++; assert.ok(cond, msg); };
  if (fs.existsSync(fixturePath)) {
    const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    selftestFixtureContract(fx, check);
    await selftestQuestionReach(fx, check, distDir);
  } else {
    console.log('fixture not present yet: fixture and question-reach checks skipped, labeller checks run alone');
  }
  selftestLabeller(check);
  console.log(`selftest OK (${n} checks)`);
}

export { selftest };
