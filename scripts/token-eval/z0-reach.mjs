#!/usr/bin/env node
/** Z0 round 3 lesson reach: where a taught lesson sits between its teach and its first apply, from the records and the request logs.
 * Read-only. Every rate is the runner's first check on first applies, never the blind G5 grade. Exit 0 on a clean read, 1 on bad input or any errors entry. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lessonIndex } from './lessons.mjs';
import { isInvalid, isLeak, isString, parseZ0Records, positionKey } from './z0-records.mjs';

const DEFAULT_SCORED = 'C:/z0-runs/scored';
const USAGE = 'usage: z0-reach.mjs [--scored DIR] [--json]';
const GRADE = 'runner-first-check';
const GRADE_NOTE = "the runner's first checks (after any post-fix regrade), not the blind G5 grades";
const SHOWN_NOTE = "builtInShown is chain.shown: the key phrase in CLAUDE.md or the loaded part of MEMORY.md (leaks.mjs:131-140); it does not count hippo's hook or SessionStart text";
const NO_BLOCK_NOTE = 'the logs hold no hook failure text; a session with no hook output at all is unknown, since a failed, timed-out and empty hook look the same there';
const FUNNEL_ARMS = ['A1', 'A2', 'A5', 'A4'];
const TEACH_ARMS = ['A0', 'A1', 'A2', 'A5', 'A4'];
const FORMS = ['No-lead', 'clean', 'absent'];
const TEACH_FORMS = ['correction', 'confirmation'];
const RULES_BLOCK = /## Rules from the user\n((?:- [^\n]*\n?)+)/g;
const NO_LEAD = /^- No[:,] /;
const BLOCK_HEADER = /## (Project Memory|Pinned rules|Prompt-Relevant Memory)[^\n]*\((\d+) entr[a-z]*, (\d+) tokens\)[^\n]*/g;
// A `## ` line is not a bound: an entry body may hold a markdown heading.
const BLOCK_END = /Today's date|<\/system-reminder>/;
// A block with no bound would run to the end of its text part, so it stops at the size hippo's budget allows.
const BLOCK_CAP = 12_000;
const ENTRY_TAGS = /\*\* \[([^\]]+)\]/g;
const JSON_STRING = /^"(?:[^"\\]|\\.)*"$/s;
const HOOK_FAILED = /UserPromptSubmit hook (?:error|failed|timed? ?out)|hook (?:timed out|timeout)/i;
const HOOK_OUTPUT = 'UserPromptSubmit hook additional context';
const NO_BLOCK_KEY = { error: 'hookErrorOrTimeout', output: 'emptyResult', none: 'unknown' };

/** @typedef {{ header: string, entries: number, tokens: number, text: string }} HookBlock */
/** @typedef {{ rules: Set<string>, hookBlocks: HookBlock[], hookSignal: 'error' | 'output' | 'none', logs: number }} Session */

const fold = (s) => s.toLowerCase().replace(/\s+/g, ' ');
const scoredOf = (r) => r.lessons.filter((l) => l.first !== 'na');
// A record whose lessons are all 'na' has no outcome; it is neither a pass nor a fail.
const outcomeOf = (r) => (scoredOf(r).length === 0 ? 'unscored' : r.lessons.some((l) => l.first === 'fail') ? 'fail' : 'pass');
const shownOf = (r) => r.chain?.shown ?? null;
const isFirstApply = (r) => r.kind === 'apply' && r.invalid === null && r.leak !== true && r.applyIndex === 1;
const counts = (items) => ({ lessons: items.length, failed: items.filter((x) => x.failed).length });
const lessonCounts = (rs) => counts(rs.flatMap(scoredOf).map((l) => ({ failed: l.first === 'fail' })));
const lessonKey = (r, l) => `${r.runName}|${r.seed}|${r.position}|${l.lessonId}`;
const teachKey = (r, l) => `${r.runName}|${r.arm}|${r.seed}|${l.lessonId}`;
const pairKey = (r) => `${r.runName.split('-')[0]}|${positionKey(r)}`;
const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();

/** A hippo prompt block's tag class, checked in a fixed order on its bracketed tag list. */
export function tagClass(tags) {
  if (tags.includes('session-digest')) return 'session-digest';
  if (tags.includes('claude-code-memory')) return 'claude-code-memory';
  if (tags.includes('error')) return 'error';
  if (tags.includes('from-user')) return 'from-user';
  if (tags.includes('rule') || tags.includes('preference')) return 'captured';
  return `other:${tags[0]}`;
}

/** Each entry of a block's text: the bracketed tag list that ends it and its length in characters, a stand-in for tokens. */
export function entriesOf(text) {
  const entries = [];
  let from = 0;
  for (const m of text.matchAll(ENTRY_TAGS)) {
    const body = text.slice(from, m.index).replace(/^\s*(?:\(\d+%\))?\s*/, '');
    entries.push({ tags: m[1].split(',').map((t) => t.trim()), chars: body.length });
    from = m.index + m[0].length;
  }
  return entries;
}

/** The bracketed tag list after each entry of a block's text. */
export const entryTags = (text) => entriesOf(text).map((e) => e.tags);

/** The SessionStart "Rules from the user" lines of a message text. */
export function ruleLinesOf(text) {
  const lines = new Set();
  for (const m of text.matchAll(RULES_BLOCK)) for (const x of m[1].split('\n')) if (x.trim()) lines.add(x.trim());
  return lines;
}

/** Hippo prompt blocks in a message text, each from its header to the next "Today's date", reminder end or hippo block header.
 * The text is trimmed, so two copies that differ only in trailing blank lines are one block. */
export function hookBlocksOf(text) {
  const headers = [...text.matchAll(BLOCK_HEADER)];
  return headers.map((m, i) => {
    const from = m.index + m[0].length;
    const body = text.slice(from, Math.min(headers[i + 1]?.index ?? text.length, from + BLOCK_CAP));
    const end = body.search(BLOCK_END);
    return { header: m[1], entries: Number(m[2]), tokens: Number(m[3]), text: (end < 0 ? body : body.slice(0, end)).trim() };
  });
}

/** Whether any hippo block holds the key phrase, case and spacing folded. */
export const blocksHold = (blocks, keyPhrase) => blocks.some((b) => fold(b.text).includes(fold(keyPhrase)));

/** How a rule line set holds a key phrase: absent, in a line opening "- No:" or "- No,", or clean. */
export function ruleFormOf(keyPhrase, rules) {
  const hit = [...rules].filter((x) => fold(x).includes(fold(keyPhrase)));
  if (hit.length === 0) return 'absent';
  return hit.some((x) => NO_LEAD.test(x)) ? 'No-lead' : 'clean';
}

/** Best-case A2 gain: A5 failures where the lesson was not loaded, less what perfect memory (A4) would still fail. */
export function headroomOf(notShown, a4, a2Lessons) {
  const a4Rate = a4.failed / a4.lessons;
  const gain = notShown.failed - notShown.lessons * a4Rate;
  return {
    unit: 'lesson', a5NotShown: notShown.lessons, a5NotShownFailed: notShown.failed, a4Failed: a4.failed, a4Lessons: a4.lessons, a4Rate,
    a2Lessons, bestCaseGain: gain, bestCaseGainPoints: (gain / a2Lessons) * 100,
  };
}

/** Teach form by (run, arm, seed, lessonId): a two-lesson family has two teach records, so family never keys it. */
export function teachFormIndex(records, errors) {
  const forms = new Map();
  for (const r of records) {
    if (r.kind !== 'teach') continue;
    for (const l of r.lessons) {
      const key = teachKey(r, l);
      if (forms.has(key)) errors.duplicatePair.push(`teach ${key}`);
      else forms.set(key, r.teachForm ?? null);
    }
  }
  return forms;
}

/** The text parts of a request's messages: user text and tool results, the places hippo output reaches the model. */
export function messageTexts(messages) {
  const texts = [];
  for (const m of messages) {
    for (const c of isString(m.content) ? [{ type: 'text', text: m.content }] : m.content) {
      if (c.type === 'text') texts.push(c.text ?? '');
      else if (c.type === 'tool_result') texts.push(...(isString(c.content) ? [c.content] : (c.content ?? []).map((x) => x.text ?? '')));
    }
  }
  return texts;
}

/** A text part that is itself a JSON string, decoded; any other part comes back as it was. */
function decodedText(text) {
  const quoted = text.trim();
  if (!JSON_STRING.test(quoted)) return text;
  try {
    return JSON.parse(quoted);
  } catch {
    // The text only looked like a JSON string (a quoted Windows path, a literal newline), so it is plain text.
    return text;
  }
}

/** Message texts as the model saw them, one per text part; a JSON-encoded part is read decoded and its encoded copy is dropped. */
export function bodyTexts(messages) {
  return messageTexts(messages).map(decodedText);
}

/** The main agent's calls carry more than 3 tools; the other model calls are its helpers. */
const isMainCall = (e, request) => isString(e.url) && e.url.includes('/v1/messages') && (request.tools?.length ?? 0) > 3;

function scanBody(e, acc) {
  const body = e.body;
  if (body.includes(HOOK_OUTPUT) && acc.hookSignal === 'none') acc.hookSignal = 'output';
  if (HOOK_FAILED.test(body)) acc.hookSignal = 'error';
  const wantsRules = body.includes('Rules from the user');
  const wantsBlocks = body.includes(' tokens)');
  if (!wantsRules && !wantsBlocks) return;
  const request = JSON.parse(body);
  const texts = bodyTexts(request.messages ?? []);
  if (wantsRules) for (const t of texts) for (const x of ruleLinesOf(t)) acc.rules.add(x);
  if (wantsBlocks && isMainCall(e, request)) for (const t of texts) for (const blk of hookBlocksOf(t)) acc.hookBlocks.set(blk.text, blk);
}

/** One pass over a session's request logs: its rule lines, hippo prompt blocks and hook signal.
 * @param {string[]} files @returns {Session} */
export function extractSession(files) {
  const acc = { rules: new Set(), hookBlocks: new Map(), hookSignal: 'none' };
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (!line.trim()) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch (err) {
        throw new Error(`${file} line ${i + 1}: ${err.message}; the request log is cut off, rerun the session or drop it from the read`);
      }
      if (e.method === 'POST' && isString(e.body) && e.body.length > 0) scanBody(e, acc);
    });
  }
  return { rules: acc.rules, hookBlocks: [...acc.hookBlocks.values()], hookSignal: acc.hookSignal, logs: files.length };
}

/** The request logs of one record's session, or the path pattern the read expected. */
export function requestLogs(scored, r) {
  const dir = path.join(scored, 'r3run', r.runName, 'run', 'raw', r.sequence, r.arm, `seed${r.seed}`);
  const names = isDir(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${r.taskId}.session`) && f.endsWith('.requests.jsonl')).sort() : [];
  return { expected: `${dir}/${r.taskId}.session*.requests.jsonl`, files: names.map((f) => path.join(dir, f)) };
}

export function runNames(scored) {
  const dirs = fs.readdirSync(path.join(scored, 'r3run'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return [...dirs.filter((n) => n.endsWith('-w1') && n !== 'gr3-w1'), 'gr3-w1b', ...dirs.filter((n) => /-e[0-9]$/.test(n))];
}

function loadRecords(scored, errors) {
  const records = [];
  let warnings = 0;
  const names = runNames(scored);
  for (const name of names) {
    const merged = path.join(scored, 'r3-merged', name);
    const src = isDir(merged) ? merged : path.join(scored, 'r3run', name, 'run');
    const regraded = path.join(src, 'runs.regraded.jsonl');
    const file = fs.existsSync(regraded) ? regraded : path.join(src, 'runs.jsonl');
    if (!fs.existsSync(file)) {
      errors.missingInput.push(`${file} (run ${name} has no records file)`);
      continue;
    }
    const parsed = parseZ0Records(fs.readFileSync(file, 'utf8'), file);
    warnings += parsed.warnings.length;
    for (const r of parsed.records) records.push(Object.assign(r, { runName: name }));
  }
  return { records, runs: names.length, warnings };
}

function loadKeyPhrases(scored, errors) {
  const phrases = new Map();
  const root = path.join(scored, 'merged-r3');
  const specs = isDir(root) ? fs.readdirSync(root).filter((d) => d.endsWith('-r')).map((d) => path.join(root, d, 'tasks-run.json')) : [];
  for (const spec of specs.filter((p) => fs.existsSync(p))) {
    for (const [id, { lesson }] of lessonIndex(JSON.parse(fs.readFileSync(spec, 'utf8')).families)) {
      if (phrases.has(id) && phrases.get(id) !== lesson.keyPhrase) errors.duplicatePair.push(`keyPhrase ${id} differs in ${spec}`);
      phrases.set(id, lesson.keyPhrase);
    }
  }
  if (phrases.size === 0) errors.missingInput.push(`${path.join(root, '*-r', 'tasks-run.json')} (no lesson key phrases)`);
  return phrases;
}

function loadBlind(scored, errors) {
  const file = path.join(scored, 'r3-final', 'unblind.json');
  if (!fs.existsSync(file)) {
    errors.missingInput.push(`${file} (the blind H1 estimate and G5 agreement)`);
    return null;
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const estimate = j.hypotheses?.H1?.violation?.estimate;
  const g5 = j.gates?.G5;
  if (!Number.isFinite(estimate) || !Number.isFinite(g5?.n)) {
    errors.missingInput.push(`${file} (hypotheses.H1.violation.estimate or gates.G5 is missing)`);
    return null;
  }
  return { source: file, h1Estimate: estimate, g5: { n: g5.n, disagreements: g5.disagreements } };
}

/** Reads every A2 and A5 first apply's request logs once; a missing log is named and the read continues. */
function readSessions(scored, firsts, errors, warn) {
  const sessions = new Map();
  for (const r of firsts.filter((x) => x.arm === 'A2' || x.arm === 'A5')) {
    const { expected, files } = requestLogs(scored, r);
    if (files.length === 0) {
      errors.missingLogs.push(expected);
      warn(`missing request log: ${expected}; the session left no log, so its rule lines and hippo blocks are not counted`);
      continue;
    }
    sessions.set(r, extractSession(files));
  }
  return sessions;
}

function funnelOf(firsts) {
  const out = {};
  for (const arm of FUNNEL_ARMS) {
    const rs = firsts.filter((r) => r.arm === arm);
    const chained = rs.filter((r) => r.chain);
    const count = (f) => chained.filter(f).length;
    const byShown = (v) => ({ records: rs.filter((r) => shownOf(r) === v).length, ...lessonCounts(rs.filter((r) => shownOf(r) === v)) });
    const shown = count((r) => r.chain.shown === true);
    out[arm] = {
      n: chained.length, stored: count((r) => r.chain.stored === true), builtInShown: shown,
      builtInShownFollowed: count((r) => r.chain.followed === true), builtInShownBroken: count((r) => r.chain.followed === false), notBuiltInShown: chained.length - shown,
      unscored: rs.filter((r) => outcomeOf(r) === 'unscored').length,
      firstCheck: { builtInShown: byShown(true), notBuiltInShown: byShown(false), noChain: byShown(null) },
    };
  }
  return out;
}

/** A first-apply record must be the only one of its arm at its (run, sequence, seed, position); a repeat is named, never merged. */
function checkUnique(firsts, errors) {
  const seen = new Set();
  for (const r of firsts) {
    const key = `${r.arm} ${pairKey(r)}`;
    if (seen.has(key)) errors.duplicatePair.push(key);
    seen.add(key);
  }
}

function armIndex(firsts, arm) {
  const index = new Map();
  for (const r of firsts.filter((x) => x.arm === arm && x.chain)) if (!index.has(pairKey(r))) index.set(pairKey(r), r);
  return index;
}

/** A2 against A5 at one position. Pairs where either side has no scored lesson are listed apart, never counted as a pass. */
function pairedOf(firsts) {
  const a2 = armIndex(firsts, 'A2');
  const a5 = armIndex(firsts, 'A5');
  const mark = { fail: 'F', pass: 'p', unscored: 'u' };
  const state = (r) => `${r.chain.shown ? 'S' : 'n'}${mark[outcomeOf(r)]}`;
  const cells = new Map();
  const shownFailed = [];
  const unscored = [];
  for (const [key, r] of a2) {
    const other = a5.get(key);
    if (!other) continue;
    const [run, sequence] = [r.runName.split('-')[0], r.sequence];
    const sortKey = `${run}|${sequence}|${String(r.seed).padStart(3, '0')}|${String(r.position).padStart(4, '0')}`;
    if (outcomeOf(r) === 'unscored' || outcomeOf(other) === 'unscored') {
      unscored.push([sortKey, { run, sequence, seed: r.seed, position: r.position, a2: state(r), a5: state(other) }]);
      continue;
    }
    const cell = `${state(r)}|${state(other)}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
    if (state(r) === 'SF') shownFailed.push([sortKey, { run, sequence, seed: r.seed, position: r.position, familyId: r.familyId, lessonSource: r.lessonSource, tasksSinceTeach: r.tasksSinceTeach, a5: state(other) }]);
  }
  const ordered = (items) => items.sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, item]) => item);
  return {
    cells: [...cells].sort().map(([k, positions]) => ({ a2: k.split('|')[0], a5: k.split('|')[1], positions })),
    a2ShownFailed: ordered(shownFailed),
    unscored: ordered(unscored),
  };
}

/** Every first-apply lesson that was scored, with its own arm's teach form; a lesson with no teach form is an error and never a bucket. */
function lessonTable(firsts, teachForms, errors) {
  const rows = [];
  for (const r of firsts.filter((x) => TEACH_ARMS.includes(x.arm))) {
    for (const l of scoredOf(r)) {
      const teachForm = teachForms.get(teachKey(r, l)) ?? null;
      if (!TEACH_FORMS.includes(teachForm)) errors.missingTeachForm.push(`${teachKey(r, l)} (${r.taskId})`);
      rows.push({ arm: r.arm, key: lessonKey(r, l), lessonId: l.lessonId, record: r, failed: l.first === 'fail', teachForm: TEACH_FORMS.includes(teachForm) ? teachForm : null });
    }
  }
  return rows;
}

/** A2's scored lessons with how the SessionStart rules and the hook block held each key phrase. */
function a2Rows(table, sessions, keyPhrases, errors) {
  const rows = [];
  for (const t of table.filter((x) => x.arm === 'A2')) {
    const session = sessions.get(t.record);
    if (!session) continue;
    const phrase = keyPhrases.get(t.lessonId);
    if (!isString(phrase) || phrase.length === 0) {
      if (!errors.missingKeyPhrase.includes(t.lessonId)) errors.missingKeyPhrase.push(t.lessonId);
      continue;
    }
    const form = ruleFormOf(phrase, session.rules);
    const inBlock = blocksHold(session.hookBlocks, phrase);
    rows.push({ ...t, form, inBlock, reached: form !== 'absent' || inBlock });
  }
  return rows;
}

function indexByArm(table) {
  const index = new Map(TEACH_ARMS.map((a) => [a, new Map()]));
  for (const t of table) index.get(t.arm).set(t.key, t);
  return index;
}

function formTable(rows, index, correctionOnly) {
  const out = {};
  for (const form of FORMS) {
    const mine = rows.filter((r) => r.form === form && (!correctionOnly || r.teachForm === 'correction'));
    const at = (arm) => mine.map((r) => index.get(arm).get(r.key)).filter((x) => x && (!correctionOnly || x.teachForm === 'correction'));
    out[form] = { A2: counts(mine), A5: counts(at('A5')), A1: counts(at('A1')) };
  }
  return out;
}

function teachFormTable(table) {
  const out = {};
  for (const arm of TEACH_ARMS) {
    out[arm] = Object.fromEntries(TEACH_FORMS.map((f) => [f, counts(table.filter((t) => t.arm === arm && t.teachForm === f))]));
  }
  return out;
}

function sessionCounts(rs, sessions) {
  const cells = new Map();
  let ruleLines = 0;
  let noLines = 0;
  for (const r of rs.filter((x) => sessions.has(x))) {
    const rules = [...sessions.get(r).rules];
    const no = rules.filter((x) => NO_LEAD.test(x)).length;
    ruleLines += rules.length;
    noLines += no;
    const key = JSON.stringify({ ruleBlock: rules.length > 0, noLine: no > 0, outcome: outcomeOf(r) });
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  return { sessions: [...cells].map(([k, n]) => ({ ...JSON.parse(k), sessions: n })), ruleLines, noLines };
}

function rulesOf(firsts, sessions, rows, table) {
  const index = indexByArm(table);
  return {
    perArm: { A2: sessionCounts(firsts.filter((r) => r.arm === 'A2'), sessions), A5: sessionCounts(firsts.filter((r) => r.arm === 'A5'), sessions) },
    allLessons: formTable(rows, index, false),
    correctionTaught: formTable(rows, index, true),
    byOwnTeachForm: teachFormTable(table),
  };
}

function reachOf(rows, index) {
  const groups = { reached: rows.filter((r) => r.reached), notReached: rows.filter((r) => !r.reached) };
  const at5 = (rs) => rs.map((r) => index.get('A5').get(r.key)).filter(Boolean);
  const routes = { ruleLine: 0, hookBlock: 0, both: 0, neither: 0 };
  for (const r of rows) routes[r.form !== 'absent' ? (r.inBlock ? 'both' : 'ruleLine') : r.inBlock ? 'hookBlock' : 'neither']++;
  return {
    hippoReach: { lessons: rows.length, reached: counts(groups.reached), notReached: counts(groups.notReached), routes },
    onHippoReach: Object.fromEntries(Object.entries(groups).map(([name, rs]) => [name, { a2: counts(rs), a5AtSamePositions: counts(at5(rs)) }])),
  };
}

/** Entry counts and characters by tag class over blocks, with the entries the headers declare and every block where the two differ. */
function entryClasses(blocksByRecord) {
  const classes = new Map();
  const mismatches = [];
  let [entries, chars, declared, tokens, blocks] = [0, 0, 0, 0, 0];
  for (const [r, hookBlocks] of blocksByRecord) {
    for (const b of hookBlocks) {
      const parsed = entriesOf(b.text);
      blocks++;
      declared += b.entries;
      tokens += b.tokens;
      if (parsed.length !== b.entries) mismatches.push({ run: r.runName, taskId: r.taskId, seed: r.seed, position: r.position, header: b.header, declared: b.entries, parsed: parsed.length });
      for (const e of parsed) {
        const c = classes.get(tagClass(e.tags)) ?? { entries: 0, chars: 0 };
        classes.set(tagClass(e.tags), { entries: c.entries + 1, chars: c.chars + e.chars });
        entries++;
        chars += e.chars;
      }
    }
  }
  const byClass = Object.fromEntries([...classes].sort((x, y) => y[1].entries - x[1].entries).map(([c, v]) => [c, { ...v, share: v.entries / entries, charShare: v.chars / chars }]));
  return { blocks, entries, entryChars: chars, declaredEntries: declared, headerTokens: tokens, byClass, entryMismatches: mismatches };
}

function blocksOf(a2, sessions) {
  const noBlock = { sessions: 0, hookErrorOrTimeout: 0, emptyResult: 0, unknown: 0 };
  const withBlocks = new Map();
  for (const r of a2.filter((x) => sessions.has(x))) {
    const { hookBlocks, hookSignal } = sessions.get(r);
    if (hookBlocks.length > 0) withBlocks.set(r, hookBlocks);
    else {
      noBlock.sessions++;
      noBlock[NO_BLOCK_KEY[hookSignal]]++;
    }
  }
  const { blocks, headerTokens, ...rest } = entryClasses(withBlocks);
  return {
    sessions: a2.length, read: a2.filter((x) => sessions.has(x)).length, withBlock: withBlocks.size, distinctBlocks: blocks,
    sessionsWithSeveralBlocks: [...withBlocks.values()].filter((b) => b.length > 1).length, ...rest,
    headerTokens: { total: headerTokens, perSession: Math.round(headerTokens / a2.length) }, noBlock: { ...noBlock, note: NO_BLOCK_NOTE },
  };
}

function crossCheckOf(firsts, blind) {
  const arm = (a) => lessonCounts(firsts.filter((r) => r.arm === a));
  const [a2, a1] = [arm('A2'), arm('A1')];
  const rate = (c) => c.failed / c.lessons;
  return {
    runnerFirstCheck: { A2: { ...a2, rate: rate(a2) }, A1: { ...a1, rate: rate(a1) }, a2MinusA1Points: (rate(a2) - rate(a1)) * 100 },
    blind,
    note: 'unit weighting and the blind grade make these differ by design; neither is asserted equal to the other',
  };
}

function droppedOf(records) {
  const out = {};
  for (const arm of TEACH_ARMS) {
    const rs = records.filter((r) => r.arm === arm && r.kind === 'apply' && r.applyIndex === 1);
    out[arm] = { leaked: rs.filter(isLeak).length, invalid: rs.filter(isInvalid).length };
  }
  return out;
}

/** The whole read over the loaded inputs.
 * @param {{ records: any[], runs: number, warnings: number, keyPhrases: Map<string, string>, sessions: Map<any, Session>, blind: any, scored: string, errors: any }} d */
export function buildReport(d) {
  const { records, errors, sessions } = d;
  const firsts = records.filter(isFirstApply);
  checkUnique(firsts.filter((r) => TEACH_ARMS.includes(r.arm)), errors);
  const table = lessonTable(firsts, teachFormIndex(records, errors), errors);
  const rows = a2Rows(table, sessions, d.keyPhrases, errors);
  const funnel = funnelOf(firsts);
  const reach = reachOf(rows, indexByArm(table));
  const a2 = firsts.filter((r) => r.arm === 'A2');
  return {
    grade: GRADE,
    inputs: {
      scored: d.scored, gradeNote: GRADE_NOTE, runs: d.runs, records: records.length, warnings: d.warnings, keyPhrases: d.keyPhrases.size, requestLogs: [...sessions.values()].reduce((n, x) => n + x.logs, 0),
      firstApplies: Object.fromEntries(TEACH_ARMS.map((a) => [a, firsts.filter((r) => r.arm === a).length])), dropped: droppedOf(records),
    },
    crossCheck: crossCheckOf(firsts, d.blind),
    funnel: { note: SHOWN_NOTE, arms: funnel },
    paired: { ...pairedOf(firsts), onHippoReach: reach.onHippoReach },
    blocks: blocksOf(a2, sessions),
    rules: rulesOf(firsts, sessions, rows, table),
    hippoReach: { note: SHOWN_NOTE, ...reach.hippoReach },
    headroom: headroomOf(funnel.A5.firstCheck.notBuiltInShown, lessonCounts(firsts.filter((r) => r.arm === 'A4')), lessonCounts(a2).lessons),
    errors,
  };
}

const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const ratio = (c) => `${c.failed}/${c.lessons}`;

function textBlocks(bl) {
  const lines = ['== blocks (A2 hippo prompt blocks)'];
  lines.push(`sessions ${bl.sessions}, with a block ${bl.withBlock} (${bl.sessionsWithSeveralBlocks} with several), distinct blocks ${bl.distinctBlocks}, header tokens ${bl.headerTokens.perSession} a session`);
  lines.push(`entries parsed ${bl.entries}, declared by the headers ${bl.declaredEntries}, characters ${bl.entryChars}; blocks where the two differ: ${bl.entryMismatches.length}`);
  for (const m of bl.entryMismatches) lines.push(`    ${m.run} ${m.taskId} seed ${m.seed} pos ${m.position} ${m.header}: declared ${m.declared}, parsed ${m.parsed}`);
  lines.push('  class: entries (share), characters (share)');
  for (const [c, v] of Object.entries(bl.byClass)) lines.push(`  ${c}: ${v.entries} (${pct(v.share)}), ${v.chars} (${pct(v.charShare)})`);
  lines.push(`  no block: ${bl.noBlock.sessions} (hook error or timeout ${bl.noBlock.hookErrorOrTimeout}, empty result ${bl.noBlock.emptyResult}, unknown ${bl.noBlock.unknown}); ${bl.noBlock.note}`);
  return lines;
}

function textRules(rules) {
  const lines = ['== rules (SessionStart "Rules from the user")'];
  for (const [arm, c] of Object.entries(rules.perArm)) {
    lines.push(`${arm}: rule lines ${c.ruleLines}, No-lines ${c.noLines}`);
    for (const s of c.sessions) lines.push(`  ${s.sessions} sessions: rule block ${s.ruleBlock}, No-line ${s.noLine}, ${s.outcome}`);
  }
  for (const [title, table] of [['all lessons', rules.allLessons], ['correction-taught only', rules.correctionTaught]]) {
    lines.push(`-- A2 rendering vs first-check fails, ${title} (failed/lessons; A5 and A1 at the same positions)`);
    for (const form of FORMS) lines.push(`  ${form}: A2 ${ratio(table[form].A2)}, A5 ${ratio(table[form].A5)}, A1 ${ratio(table[form].A1)}`);
  }
  lines.push('-- first-apply fails by own teach form');
  for (const [arm, forms] of Object.entries(rules.byOwnTeachForm)) lines.push(`  ${arm}: correction ${ratio(forms.correction)}, confirmation ${ratio(forms.confirmation)}`);
  return lines;
}

/** The report as plain text, one section per block. */
export function formatText(rep) {
  const lines = [`grade: ${rep.grade} (${rep.inputs.gradeNote})`];
  lines.push(`inputs: ${rep.inputs.runs} runs, ${rep.inputs.records} records, ${rep.inputs.keyPhrases} key phrases, ${rep.inputs.requestLogs} request logs; first applies ${JSON.stringify(rep.inputs.firstApplies)}`);
  lines.push(`dropped first-apply records: ${JSON.stringify(rep.inputs.dropped)}`);
  const cc = rep.crossCheck;
  const b = cc.blind;
  lines.push(`crossCheck: runner first-check fails A2 ${ratio(cc.runnerFirstCheck.A2)} vs A1 ${ratio(cc.runnerFirstCheck.A1)} = ${cc.runnerFirstCheck.a2MinusA1Points.toFixed(1)} points`);
  lines.push(b ? `  blind H1 estimate ${b.h1Estimate.toFixed(4)}; G5 n ${b.g5.n}, disagreements ${b.g5.disagreements}; ${cc.note}` : '  blind read unavailable (see errors.missingInput)');
  lines.push('== funnel', `note: ${rep.funnel.note}`);
  for (const [arm, f] of Object.entries(rep.funnel.arms)) {
    lines.push(`${arm}: n=${f.n} stored=${f.stored} builtInShown=${f.builtInShown} followed=${f.builtInShownFollowed} broken=${f.builtInShownBroken} notBuiltInShown=${f.notBuiltInShown} unscored=${f.unscored}`);
    lines.push(`  first-check fails: builtInShown ${ratio(f.firstCheck.builtInShown)}, not builtInShown ${ratio(f.firstCheck.notBuiltInShown)}`);
  }
  lines.push('== paired (A2 vs A5, same position; S shown n not shown, F failed p passed)');
  for (const c of rep.paired.cells) lines.push(`  ${c.positions} A2 ${c.a2} A5 ${c.a5}`);
  for (const p of rep.paired.a2ShownFailed) lines.push(`  A2 shown and failed: ${p.run} ${p.sequence} seed ${p.seed} pos ${p.position} ${p.familyId} ${p.lessonSource} since-teach ${p.tasksSinceTeach} A5 ${p.a5}`);
  lines.push(`  unscored pairs (no scored lesson on one side, in no cell): ${rep.paired.unscored.length}`);
  for (const p of rep.paired.unscored) lines.push(`    ${p.run} ${p.sequence} seed ${p.seed} pos ${p.position} A2 ${p.a2} A5 ${p.a5}`);
  lines.push(...textBlocks(rep.blocks), ...textRules(rep.rules));
  const hr = rep.hippoReach;
  lines.push('== hippoReach (key phrase in a SessionStart rule line or a hook block)', `note: ${hr.note}`);
  lines.push(`lessons ${hr.lessons}: reached ${ratio(hr.reached)} A2 fails, not reached ${ratio(hr.notReached)}; routes ${JSON.stringify(hr.routes)}`);
  for (const [name, v] of Object.entries(rep.paired.onHippoReach)) lines.push(`  paired.onHippoReach ${name}: A2 ${ratio(v.a2)}, A5 at the same positions ${ratio(v.a5AtSamePositions)}`);
  const h = rep.headroom;
  lines.push('== headroom (unit: lesson)', `A5 not loaded ${h.a5NotShown}, their fails ${h.a5NotShownFailed}, A4 fail rate ${h.a4Failed}/${h.a4Lessons}, best-case A2 gain ${h.bestCaseGain.toFixed(1)} fails = ${h.bestCaseGainPoints.toFixed(1)} points of ${h.a2Lessons}`);
  for (const [k, v] of Object.entries(rep.errors)) lines.push(`errors.${k}: ${v.length}${v.length > 0 ? ` (first: ${v[0]})` : ''}`);
  return `${lines.join('\n')}\n`;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { scored: DEFAULT_SCORED, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return { ...args, help: true };
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--scored') {
      const value = argv[++i];
      if (!isString(value) || value.startsWith('--')) throw new Error(`--scored needs a directory\n${USAGE}`);
      args.scored = value;
    } else throw new Error(`unknown flag ${argv[i]}\n${USAGE}`);
  }
  return args;
}

/** Loads the inputs, reads the logs and builds the report; `warn` gets one line per missing log.
 * @param {string} scored @param {(line: string) => void} warn */
export function readReach(scored, warn = () => {}) {
  if (!isDir(path.join(scored, 'r3run'))) throw new Error(`no round 3 runs at ${path.join(scored, 'r3run')}; pass --scored <dir> with the scored folder that holds r3run/`);
  const errors = { missingLogs: [], missingKeyPhrase: [], duplicatePair: [], missingTeachForm: [], missingInput: [] };
  const { records, runs, warnings } = loadRecords(scored, errors);
  const sessions = readSessions(scored, records.filter(isFirstApply), errors, warn);
  return buildReport({ records, runs, warnings, keyPhrases: loadKeyPhrases(scored, errors), sessions, blind: loadBlind(scored, errors), scored, errors });
}

/** @param {string[]} argv */
export function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };
    const notes = [];
    const report = readReach(args.scored, (line) => notes.push(`${line}\n`));
    const failed = Object.entries(report.errors).find(([, v]) => v.length > 0);
    const summary = failed ? `z0-reach: errors.${failed[0]} has ${failed[1].length} entries, first: ${failed[1][0]}; fix that input and rerun\n` : '';
    return { code: failed ? 1 : 0, stdout: args.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report), stderr: notes.join('') + summary };
  } catch (e) {
    return { code: 1, stdout: '', stderr: `z0-reach: ${e.message}\n` };
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
