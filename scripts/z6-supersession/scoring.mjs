// Z6 scoring: turns the rows one run saw into values, a label per scenario, diagnostics and the run verdict; no I/O.
import { esc, hasWord, norm } from './fixture.mjs';

// oracle-sleep is oracle with the daily runs and interleave notes on; reported only, never part of the verdict.
const ARMS = ['capture', 'remember', 'oracle', 'oracle-sleep'];

function wilson(k, m) {
  if (!m) return [0, 0];
  const z = 1.96, p = k / m, d = 1 + (z * z) / m;
  const c = (p + (z * z) / (2 * m)) / d, w = (z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m))) / d;
  // a proportion's CI cannot leave [0,1]; clamp off the float noise a k=0 or k=m interval otherwise leaves at the edge.
  return [Math.max(0, c - w), Math.min(1, c + w)];
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

// --- verdict ---

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

export { ARMS, wilson, computeValues, isRetired, captured, vanishedCause, carriersLost, addCauses, computeReach, chainReaches,
  reasonTest, contextShows, labelChange, labelControl, fillerCounts, fillerLostTotal, changeDiagnostics, computeVerdict };
