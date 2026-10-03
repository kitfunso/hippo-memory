// Z0 lesson families: tasks-file rules (prereg 32-46, 62-68, 111), the per-seed task order (117-119), roles and teach text.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const KINDS = ['teach', 'apply', 'no-lesson'];
const SOURCES = ['maintainer', 'template'];
// The plain word "memory" stays legal: a maintainer rule can be about memory allocation.
const MEMORY_WORDS = /\bremember|\bhippo\b|\bauto[ -]?memory\b|MEMORY\.md|CLAUDE\.md|AGENTS\.md|CLAUDE\.local\.md|\.claude\/rules/i;
const SCREEN_FIELDS = ['id', 'baseRef', 'fixRef', 'prompt', 'test'];
const MAX_RESTARTS = 10_000;

/** lessonId -> { lesson, family }. */
export function lessonIndex(families) {
  const index = new Map();
  for (const f of families) for (const l of f.lessons ?? []) index.set(l.id, { lesson: l, family: f });
  return index;
}

function checkTaskRole(t, families, index) {
  if (t.set === 'X') throw new Error(`task ${t.id}: set X needs the Codex runner (E6)`);
  if (!KINDS.includes(t.kind)) throw new Error(`task ${t.id}: kind must be one of ${KINDS.join(', ')} (got ${t.kind ?? 'none'})`);
  if (t.kind === 'no-lesson') {
    if (t.familyId || t.lessonId) throw new Error(`task ${t.id}: a no-lesson task takes no familyId or lessonId`);
    return;
  }
  if (!t.familyId || !t.lessonId) throw new Error(`task ${t.id}: a ${t.kind} task needs familyId and lessonId`);
  if (!families.some((f) => f.id === t.familyId)) throw new Error(`task ${t.id}: unknown family ${t.familyId}`);
  const hit = index.get(t.lessonId);
  if (!hit || hit.family.id !== t.familyId) throw new Error(`task ${t.id}: family ${t.familyId} has no lesson ${t.lessonId}`);
  if (t.kind === 'apply' && !t.keyPhraseAllowed && t.prompt.toLowerCase().includes(hit.lesson.keyPhrase.toLowerCase())) {
    throw new Error(`task ${t.id}: the apply prompt holds lesson ${t.lessonId}'s key phrase "${hit.lesson.keyPhrase}" (set keyPhraseAllowed to keep it)`);
  }
}

function checkLesson(l, baseDir) {
  for (const f of ['rule', 'reason', 'keyPhrase']) if (!l[f]) throw new Error(`lesson ${l.id} needs a ${f}`);
  if (!l.check?.script) throw new Error(`lesson ${l.id} needs check.script`);
  for (const f of ['rule', 'reason']) {
    if (MEMORY_WORDS.test(l[f])) throw new Error(`lesson ${l.id}: a ${f} must never say remember or name a memory tool or file ("${l[f]}")`);
  }
  if (!baseDir) throw new Error('validateTasks needs the tasks file\'s directory to resolve checker scripts');
  l.checkPath = path.resolve(baseDir, l.check.script);
  if (!fs.existsSync(l.checkPath)) throw new Error(`lesson ${l.id}: check.script ${l.check.script} not found at ${l.checkPath}`);
}

function checkFamilyLessons(f, spec, baseDir) {
  if (!SOURCES.includes(f.lessonSource)) throw new Error(`family ${f.id}: lessonSource must be one of ${SOURCES.join(', ')}`);
  const lessons = f.lessons ?? [];
  const ids = new Set(lessons.map((l) => l.id));
  const roots = lessons.filter((l) => !l.supersedes);
  if (roots.length !== 1) throw new Error(`family ${f.id} needs exactly one root lesson (one without supersedes), has ${roots.length}`);
  const reversals = lessons.filter((l) => l.supersedes);
  if (reversals.length > 1 || reversals.some((l) => l.supersedes !== roots[0].id || !ids.has(l.supersedes))) {
    throw new Error(`family ${f.id} allows one reversal: at most one lesson, superseding the root lesson ${roots[0].id}`);
  }
  for (const l of lessons) checkLesson(l, baseDir);
  if (f.screen) {
    for (const k of SCREEN_FIELDS) if (!f.screen[k]) throw new Error(`family ${f.id}: screen task missing "${k}"`);
    if (!Array.isArray(f.screen.testFiles)) throw new Error(`family ${f.id}: screen task needs a "testFiles" array`);
  } else if (!f.screenSkipped) {
    throw new Error(`family ${f.id} needs a screen task (or screenSkipped with a screenNote in a dev file)`);
  } else if (!f.screenNote) {
    throw new Error(`family ${f.id}: screenSkipped needs a screenNote`);
  } else if (spec.dev !== true) {
    throw new Error(`family ${f.id}: screenSkipped is only accepted when the tasks file sets "dev": true`);
  }
}

function checkFamilyTasks(f, spec) {
  const homes = new Set();
  const tasks = [];
  for (const s of spec.sequences) for (const t of s.tasks) if (t.familyId === f.id) { homes.add(s.id); tasks.push(t); }
  if (homes.size > 1) throw new Error(`family ${f.id}: its tasks must sit in one sequence, found ${[...homes].join(', ')}`);
  const home = [...homes][0];
  if (f.sequence !== home) throw new Error(`family ${f.id} says sequence ${f.sequence} but its tasks sit in ${home ?? 'no sequence'}`);
  for (const l of f.lessons) {
    const teaches = tasks.filter((t) => t.kind === 'teach' && t.lessonId === l.id).length;
    if (teaches !== 1) throw new Error(`lesson ${l.id} needs exactly one teach task, has ${teaches}`);
  }
  const applies = tasks.filter((t) => t.kind === 'apply');
  if (applies.length < 2) throw new Error(`family ${f.id} needs at least 2 apply tasks, has ${applies.length}`);
  for (const l of f.lessons) {
    if (!applies.some((t) => t.lessonId === l.id)) throw new Error(`lesson ${l.id} has no apply task`);
  }
}

/** Throw on the first lesson-family problem, naming the family, lesson or task. Stores each checker's absolute path. */
export function validateFamilies(spec, baseDir) {
  const families = spec.families ?? [];
  if (!Array.isArray(families)) throw new Error('"families" must be an array');
  const familyIds = new Set();
  for (const f of families) {
    if (!f.id || familyIds.has(f.id)) throw new Error(`family id ${f.id ?? '(missing)'} is missing or repeated`);
    familyIds.add(f.id);
  }
  const lessonIds = families.flatMap((f) => (f.lessons ?? []).map((l) => l.id));
  const repeated = lessonIds.find((id, i) => lessonIds.indexOf(id) !== i);
  if (repeated) throw new Error(`lesson id ${repeated} is used twice`);
  const index = lessonIndex(families);
  for (const s of spec.sequences) for (const t of s.tasks) checkTaskRole(t, families, index);
  for (const f of families) checkFamilyLessons(f, spec, baseDir);
  for (const f of families) checkFamilyTasks(f, spec);
  return spec;
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What drawOrder needs to know about a sequence's lessons. */
function orderContext(sequence, families) {
  const index = lessonIndex(families);
  const taughtHere = new Set(sequence.tasks.filter((t) => t.kind === 'teach').map((t) => t.lessonId));
  const applyIds = new Map();
  for (const t of sequence.tasks) if (t.kind === 'apply') applyIds.set(t.lessonId, [...(applyIds.get(t.lessonId) ?? []), t.id]);
  const reversalOf = new Map();
  for (const id of taughtHere) {
    const l = index.get(id)?.lesson;
    if (l?.supersedes) reversalOf.set(l.supersedes, l.id);
  }
  const keyed = [...taughtHere].map((id) => index.get(id)?.lesson).filter(Boolean);
  return { index, applyIds, reversalOf, keyed };
}

/** The lesson whose key phrase task t would leak at the next position (G3), or null. */
function leakedLesson(t, state, ctx) {
  if (!ctx.keyed.length) return null;
  const prompt = t.prompt.toLowerCase();
  // keyPhraseAllowed lets a task name its own lesson only; every other untaught lesson is still checked.
  const own = (l) => t.lessonId === l.id && (t.kind === 'teach' || t.keyPhraseAllowed);
  const open = (l) => !state.teachAt.has(l.id) && !own(l);
  return ctx.keyed.find((l) => open(l) && prompt.includes(l.keyPhrase.toLowerCase())) ?? null;
}

function leakReason(t, state, ctx) {
  const l = leakedLesson(t, state, ctx);
  return l ? `task ${t.id} prompt holds the key phrase of lesson ${l.id} before its teach task` : null;
}

/** Why task t cannot go at the next position, or null. A leak is checked first so it names the task that leaks. */
function blockReason(t, state, ctx) {
  const leak = leakReason(t, state, ctx);
  if (leak) return leak;
  const l = t.lessonId;
  if (t.kind === 'apply') {
    if (!state.teachAt.has(l)) return `apply ${t.id} comes before the teach task of lesson ${l}`;
    const reversal = ctx.reversalOf.get(l);
    if (reversal && state.teachAt.has(reversal)) return `apply ${t.id} of lesson ${l} comes after the reversal ${reversal} was taught`;
    if ((state.applied.get(l) ?? 0) === 0 && state.placed.length - state.teachAt.get(l) - 1 < 2) {
      return `fewer than 2 tasks between the teach task of lesson ${l} and its first apply ${t.id} (prereg 118)`;
    }
  }
  const old = t.kind === 'teach' ? ctx.index.get(l)?.lesson.supersedes : null;
  if (old) {
    const pending = (ctx.applyIds.get(old) ?? []).filter((id) => !state.placedIds.has(id));
    if (pending.length) return `reversal teach ${t.id} of lesson ${l} comes before apply ${pending.join(', ')} of lesson ${old}`;
  }
  return null;
}

function newState() {
  return { placed: [], placedIds: new Set(), teachAt: new Map(), applied: new Map() };
}

function place(t, state) {
  if (t.kind === 'teach') state.teachAt.set(t.lessonId, state.placed.length);
  if (t.kind === 'apply') state.applied.set(t.lessonId, (state.applied.get(t.lessonId) ?? 0) + 1);
  state.placed.push(t.id);
  state.placedIds.add(t.id);
}

/** One randomized greedy pass: the order, or the reason the first stuck task gives. */
function greedyPass(tasks, ctx, rand) {
  const state = newState();
  let left = tasks.slice();
  while (left.length) {
    const open = left.filter((t) => !blockReason(t, state, ctx));
    if (!open.length) return { reason: blockReason(left[0], state, ctx) };
    const pick = open[Math.floor(rand() * open.length)];
    place(pick, state);
    left = left.filter((t) => t !== pick);
  }
  return { order: state.placed };
}

function checkFixed(sequence, ctx) {
  const state = newState();
  for (const t of sequence.tasks) {
    const reason = blockReason(t, state, ctx);
    if (reason) throw new Error(`sequence ${sequence.id} (fixedOrder): ${reason}`);
    place(t, state);
  }
  return state.placed;
}

/** Task ids in run order for one seed; the same for every arm on that seed (prereg 117). */
export function drawOrder(sequence, families, seed) {
  const ctx = orderContext(sequence, families);
  if (sequence.fixedOrder) return checkFixed(sequence, ctx);
  const rand = mulberry32(fnv1a(`${sequence.id}|${seed}`));
  const tally = new Map();
  for (let i = 0; i < MAX_RESTARTS; i++) {
    const r = greedyPass(sequence.tasks, ctx, rand);
    if (r.order) return r.order;
    tally.set(r.reason, (tally.get(r.reason) ?? 0) + 1);
  }
  const [worst, count] = [...tally].sort((a, b) => b[1] - a[1])[0];
  throw new Error(`sequence ${sequence.id}: no order on seed ${seed} after ${MAX_RESTARTS} draws; most frequent block (${count}): ${worst}`);
}

/** Every task placed before a lesson's teach task whose prompt holds that lesson's key phrase (G3), as {taskId, lessonId}. */
export function promptLeaks(orderTasks, families) {
  const ctx = orderContext({ tasks: orderTasks }, families);
  const state = newState();
  const leaks = [];
  for (const t of orderTasks) {
    const l = leakedLesson(t, state, ctx);
    if (l) leaks.push({ taskId: t.id, lessonId: l.id });
    place(t, state);
  }
  return leaks;
}

const NULL_ROLE = { applyIndex: null, afterReversal: null, tasksSinceTeach: null };

/** Per position: kind, family, lesson, source, and the apply-only fields E7 cross-checks (null off apply). */
export function taskRoles(orderTasks, families) {
  const index = lessonIndex(families);
  const lastTeach = new Map();
  const applies = new Map();
  return orderTasks.map((t, pos) => {
    if (t.kind === 'no-lesson') return { kind: t.kind, familyId: null, lessonId: null, lessonSource: null, ...NULL_ROLE, set: 'N' };
    const { lesson, family } = index.get(t.lessonId);
    const role = { kind: t.kind, familyId: family.id, lessonId: lesson.id, lessonSource: family.lessonSource, ...NULL_ROLE, set: 'R' };
    if (t.kind === 'teach') {
      lastTeach.set(family.id, pos);
      return role;
    }
    applies.set(family.id, (applies.get(family.id) ?? 0) + 1);
    return { ...role, applyIndex: applies.get(family.id), afterReversal: Boolean(lesson.supersedes), tasksSinceTeach: pos - lastTeach.get(family.id) - 1 };
  });
}

/** The fixed teach templates (prereg 105-107), built from the lesson's own rule and reason only. */
export function teachMessage(lesson, form) {
  if (form === 'correction') return `No: ${lesson.rule}, because ${lesson.reason}. Please fix it.`;
  if (form === 'confirmation') return `Yes, keep doing that: ${lesson.rule}, because ${lesson.reason}.`;
  throw new Error(`teach message form must be correction or confirmation, got ${form}`);
}

/** A4's taught list after one more lesson; a reversal replaces the lesson it supersedes. */
export function withTaught(taught, lesson) {
  return [...taught.filter((l) => l.id !== lesson.id && l.id !== lesson.supersedes), lesson];
}

/** The text A4 appends to the root CLAUDE.md: nothing before the first lesson. */
export function memoryText(taught) {
  if (!taught.length) return '';
  return `\n${taught.map((l) => `- ${l.rule}, because ${l.reason}.\n`).join('')}`;
}

const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'its', 'you', 'all', 'any', 'can', 'has', 'had', 'her', 'was', 'one', 'our', 'out', 'use', 'with', 'that', 'this', 'from', 'they', 'have', 'into', 'only', 'when', 'then', 'than', 'them']);
const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Share of the rule's distinct content words that occur in the prompt; 0 when the rule has none. */
export function wordOverlap(prompt, rule) {
  const content = new Set(words(rule).filter((w) => w.length >= 3 && !STOP.has(w)));
  if (!content.size) return 0;
  const seen = new Set(words(prompt));
  return [...content].filter((w) => seen.has(w)).length / content.size;
}
