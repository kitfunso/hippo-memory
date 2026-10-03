// Pure helpers for the Z7b strict sub-agent lesson eval (prereg docs/evals/2026-10-03-z7b-sidechain-strict-prereg.md). No fs, no child_process.
import * as L from './z7-sidechain-lib.mjs';

export const SEED_STRING = 'z7b-2026-10-03';
export const SESSION_CAP = 5;
export const PIN_PROMPTS = ['judge-prompt.txt', 'judge-system.txt', 'recheck-prompt.txt', 'filter-prompt.txt'];
export const LOCK_NAME = 'z7b-sidechain-strict.json';
export const FILTER_LABELS = ['file', 'self', 'known', 'result', 'keep'];
export const MARK_CLASSES = ['file', 'self', 'known', 'result', 'present', 'other'];
export const Z7_SCORED_SHA = 'cb58dd16d537be7ec882c2faa18d82687bf9af3fac917be644592bd5f9c808ac';
export const PRECISION_SAMPLE = 12;
export const FALSEX_SAMPLE = 8;
export const AUDIT_DROPPED = 4;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v) => v !== null && v instanceof Object && !Array.isArray(v);
const idOf = (it) => L.itemId(it.session, it.file);
const tplKey = (it) => `${it.session}|${it.template}`;

// --- draw ---

// z7Fresh is L.buildDraw(eligible); its dev and scored items are Z7b's dev set, so they can only tune.
export function buildDrawZ7b(eligible, z7Fresh) {
  const dev = [...z7Fresh.dev, ...z7Fresh.scored];
  const devSet = new Set(dev);
  const devTpl = new Set(eligible.filter((it) => devSet.has(idOf(it))).map(tplKey));
  const pool = eligible.filter((it) => !devSet.has(idOf(it)) && !devTpl.has(tplKey(it))).sort((a, b) => cmp(a.session, b.session) || cmp(a.file, b.file));
  const taken = new Map();
  const picked = [];
  for (const it of L.shuffled(pool, L.rngFromString(SEED_STRING))) {
    const t = taken.get(it.session) ?? { n: 0, tpl: new Set() };
    if (t.n >= SESSION_CAP || t.tpl.has(it.template)) continue;
    t.n++;
    t.tpl.add(it.template);
    taken.set(it.session, t);
    picked.push(it);
  }
  const scored = picked.map(idOf);
  const items = {};
  for (const id of dev) items[id] = { ...z7Fresh.items[id] };
  for (const it of picked) items[idOf(it)] = { session: it.session, file: it.file, agentType: it.agentType, project: it.project };
  return {
    seedString: SEED_STRING, seedHex: L.sha256(SEED_STRING).slice(0, 8), z7ScoredSha256: z7Fresh.itemListSha256,
    eligibleSubs: eligible.length, eligibleSessions: new Set(eligible.map((i) => i.session)).size,
    poolSubs: pool.length, poolSessions: new Set(pool.map((i) => i.session)).size,
    scoredSessions: new Set(picked.map((i) => i.session)).size, dev, scored, items, itemListSha256: L.sha256(scored.join('\n')),
  };
}

// Z7's drawMismatch contract, but a missing pin never matches.
export function drawMismatchZ7b(fresh, stored, pinSha) {
  if (!pinSha) return 'there is no scored list sha256 pin';
  return L.drawMismatch(fresh, stored, pinSha);
}

// in: {manifestSha, z7Fresh, z7Stored, fresh, stored}. Returns why the draw cannot stand, or null.
export function checkDrawZ7b(inp, pins, z7Pin = Z7_SCORED_SHA) {
  const bad = L.checkPins(pins, { manifest: inp.manifestSha, scoredList: inp.fresh.itemListSha256 }, PIN_PROMPTS);
  if (bad.length) return `pin mismatch: ${bad.join(', ')}`;
  const z7 = L.drawMismatch(inp.z7Fresh, inp.z7Stored, z7Pin);
  if (z7) return `Z7 dev set: ${z7}`;
  return drawMismatchZ7b(inp.fresh, inp.stored, pins.scoredList);
}

// --- prompt hashes ---

export function promptShaAgree(sidecars, current, names) {
  if (!sidecars.length) return false;
  return sidecars.every((s) => isObj(s) && names.every((n) => L.isStr(current[n]) && s[n] === current[n]));
}

// Only the named prompts count; parsePins collects every backticked .txt hash in the section.
export const pinsMatchPrompts = (pins, promptSha, names) => names.every((n) => Boolean(pins.prompts[n]) && pins.prompts[n] === promptSha?.[n]);

// --- filter ---

export function parseFilter(stdout, n) {
  const o = L.parseJsonReply(stdout);
  if (!o || !Array.isArray(o.labels)) return { ok: false, labels: [] };
  const labels = Array.from({ length: n }, () => null);
  for (const l of o.labels) {
    if (!isObj(l) || !Number.isInteger(l.i) || l.i < 0 || l.i >= n || labels[l.i] !== null || !FILTER_LABELS.includes(l.label)) return { ok: false, labels: [] };
    labels[l.i] = l.label;
  }
  return labels.includes(null) ? { ok: false, labels: [] } : { ok: true, labels };
}

// The recheck-surviving lessons in filter order, each keeping the judge's own index k.
export function candidates(judge, recheck, id) {
  const gone = recheck[id]?.keptKeys ?? [];
  return L.MODELS.flatMap((model) => (judge[model][id]?.verified ?? []).flatMap((l, k) => (gone.includes(`${model}:${k}`) ? [] : [{ model, k, kind: l.kind, text: l.text }])));
}

export const removalKeys = (cands, parsed) => (parsed.ok ? cands.filter((_, i) => parsed.labels[i] !== 'keep').map((c) => `${c.model}:${c.k}`) : []);

// filter.items[id].removed become extra keptKeys, the same trick Z7 uses for its aug row.
export function mergeRemovals(recheck, filter) {
  return Object.fromEntries(Object.entries(recheck).map(([id, r]) => [id, filter.items[id] ? { ...r, keptKeys: [...r.keptKeys, ...filter.items[id].removed] } : r]));
}

export function filterStats(filter) {
  const its = Object.values(filter.items);
  const labels = Object.fromEntries(FILTER_LABELS.map((l) => [l, 0]));
  for (const it of its) for (const l of it.ok ? it.labels : []) labels[l]++;
  return { parse: [its.filter((i) => i.ok).length, its.length], labels };
}

// --- gates and verdict ---

export function gatesZ7b(fUnf, isolation, control, filterParse) {
  const g = L.gateResults({ isolation, parse: fUnf.parse, evidenceFail: fUnf.evidenceFail, control, unplanted: fUnf.unplanted, planted: fUnf.planted });
  const [k, n] = filterParse;
  g.G2 = { ...g.G2, filter: n ? k / n >= 0.95 : null };
  return g;
}

// BUILD cannot be decided before the precision audit, so only INVALID and DROP are final here.
export function verdictZ7b(ci, unionUnfCi, valid) {
  if (!valid) return 'INVALID';
  if (unionUnfCi.hi < 0.1) return 'DROP';
  return 'PENDING_AUDIT';
}

export function finalizeAuditZ7b(preliminary, ci, n, confirmed) {
  const share = n ? confirmed / n : null;
  const adjustedLo = share === null ? null : ci.lo * share;
  const build = share !== null && share >= 0.75 && adjustedLo >= 0.1;
  return {
    sampleN: n, confirmed, share, adjustedLo, preliminary,
    final: preliminary === 'PENDING_AUDIT' ? (build ? 'BUILD' : 'INCONCLUSIVE') : preliminary,
    strong: n > 0 && ci.lo >= 0.2 && share >= 0.75,
  };
}

// --- calibration and audit samples ---

const sample = (ids, rng) => L.shuffled([...ids].sort(cmp), rng);

export function calibSamples(round, bearingIds, removedIds, priorIds) {
  const rng = L.rngFromString(`z7b-calib-r${round}`);
  const prior = new Set(priorIds);
  const fresh = (ids) => { const s = sample(ids, rng); return [...s.filter((id) => !prior.has(id)), ...s.filter((id) => prior.has(id))]; };
  return { precision: fresh(bearingIds).slice(0, PRECISION_SAMPLE), falsex: fresh(removedIds).slice(0, FALSEX_SAMPLE) };
}

const markOk = (m) => m === 'confirmed' || (L.isStr(m) && m.startsWith('rejected:') && MARK_CLASSES.includes(m.slice(9)));

export function checkMarks(marks, sampleIds) {
  if (!isObj(marks)) return 'the marks must be an object keyed by id';
  const missing = sampleIds.find((id) => !Object.hasOwn(marks, id));
  if (missing) return `no mark for ${missing}`;
  const extra = Object.keys(marks).find((id) => !sampleIds.includes(id));
  if (extra) return `a mark for ${extra}, which is not in the sample`;
  const bad = sampleIds.find((id) => !markOk(marks[id]));
  return bad ? `unknown mark for ${bad}` : null;
}

export function summariseMarks(marks) {
  const vals = Object.values(marks);
  const byClass = {};
  for (const v of vals) if (v !== 'confirmed') byClass[v.slice(9)] = (byClass[v.slice(9)] ?? 0) + 1;
  return { n: vals.length, confirmed: vals.filter((v) => v === 'confirmed').length, byClass };
}

export const calibPass = (precisionMarks) => {
  const { n, confirmed } = summariseMarks(precisionMarks);
  return n >= 10 && confirmed * 4 >= n * 3;
};

// 12 bearing plus 4 bearing-before-filter-only items, in one shuffled list with no labels.
export function auditSample(bearingIds, droppedIds) {
  const rng = L.rngFromString('z7b-audit');
  const bearing = sample(bearingIds, rng).slice(0, PRECISION_SAMPLE);
  const dropped = sample(droppedIds, rng).slice(0, AUDIT_DROPPED);
  return { ids: L.shuffled([...bearing, ...dropped], rng), bearing, dropped };
}
