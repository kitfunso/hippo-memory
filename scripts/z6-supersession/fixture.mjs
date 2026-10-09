// The Z6 fixture contract: content-hash scenario ids, the tune and held-out split, the shape checks and their marker matching.
import crypto from 'node:crypto';
import { mulberry32 } from '../lib/prng.mjs';

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

export { esc, hasWord, norm, sentences, TUNE, assignSplit, fixtureId, STOP, fixtureProblems };
