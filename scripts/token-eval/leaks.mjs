// G3 (prereg 164): a lesson's key phrase the agent could read before that lesson's teach voids the (sequence, seed).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { gitSpawn } from './exec.mjs';
import { agentGit } from './checks.mjs';
import { RESTORABLE, isImported, collapse } from './surfaces.mjs';
import { ownsPhrase } from './lessons.mjs';

// Bytes as latin1 with ASCII-only case folding, so a non-ASCII phrase matches its exact UTF-8 bytes.
const fold = (data) => Buffer.from(data).toString('latin1').replace(/[A-Z]+/g, (m) => m.toLowerCase());
export const holds = (text, phrase) => fold(text).includes(fold(phrase));

// zip (three headers), 7z, xz, zstd, rar; bzip2 is 'BZh' plus a block-size digit.
const MAGIC = [[0x50, 0x4b, 3, 4], [0x50, 0x4b, 5, 6], [0x50, 0x4b, 7, 8], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0], [0x28, 0xb5, 0x2f, 0xfd], [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]];
const startsWith = (bytes, magic) => magic.every((v, i) => bytes[i] === v);
const isBzip2 = (b) => b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68 && b[3] >= 0x31 && b[3] <= 0x39;

/** A file's folded text; null for an archive the search cannot open, which counts as a hit. */
function searchable(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return fold(gunzipSync(bytes));
    } catch (err) {
      if (err.code?.startsWith('Z_')) return null;
      throw err;
    }
  }
  return MAGIC.some((m) => startsWith(bytes, m)) || isBzip2(bytes) ? null : fold(bytes);
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    // A dangling link, or a hippo WAL file the store closed after the snapshot listed it.
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Paths in commit `pre` of the workspace holding `phrase`, case-folded by git. */
function workspaceFiles(work, pre, phrase) {
  return agentGit(work, (rgit) => {
    try {
      return rgit(['grep', '-z', '-l', '-i', '-F', '-e', phrase, pre], work);
    } catch (err) {
      // git grep exits 1 when nothing matches.
      if (err.status === 1) return '';
      throw err;
    }
  }).split('\0').filter(Boolean).map((p) => p.slice(pre.length + 1));
}

/** Each surface entry's bytes as `{key, e, bytes}`, skipping entries the snapshot could not read and files gone since. */
function* surfaceBytes(root, surfaces, keys) {
  for (const key of keys) {
    for (const e of surfaces[key] ?? []) {
      const bytes = e.error ? null : readOrNull(path.join(root, e.path));
      if (bytes) yield { key, e, bytes };
    }
  }
}

/** Each lesson's key phrase in the memory surface files and the hippo store entries; an archive hit names no lesson. */
function surfaceLeaks(lessons, { root, surfaces, stores }) {
  const phrases = lessons.map((l) => ({ id: l.id, folded: fold(l.keyPhrase) }));
  const hits = [];
  const scan = (text, surface, at) => {
    for (const p of phrases) if (text.includes(p.folded)) hits.push({ lessonId: p.id, surface, path: at });
  };
  for (const { key, e, bytes } of surfaceBytes(root, surfaces, [...RESTORABLE, 'instructions'])) {
    const text = searchable(bytes);
    if (text === null) hits.push({ lessonId: null, surface: `${key}-archive`, path: e.path });
    else scan(text, key, e.path);
  }
  for (const s of stores) for (const e of s.entries) scan(fold(e.content), s.surface, `${s.path}#${e.id}`);
  return hits;
}

/** Every place an open lesson's key phrase sits before the session, as `{lessonId, surface, path}`; an archive hit names no lesson. */
export function findLeaks(open, { t, root, work, pre, surfaces, stores }) {
  if (!open.length) return [];
  const hits = surfaceLeaks(open, { root, surfaces, stores });
  for (const l of open) for (const rel of workspaceFiles(work, pre, l.keyPhrase)) hits.push({ lessonId: l.id, surface: 'workspace', path: `work/${rel}` });
  for (const l of open) if (!ownsPhrase(t, l) && holds(t.prompt, l.keyPhrase)) hits.push({ lessonId: l.id, surface: 'prompt', path: null });
  return hits;
}

/** Chain `stored` (prereg 179): the lesson's key phrase in any memory surface or hippo store at the apply's pre-session. */
export const storedAt = (lesson, at) => surfaceLeaks([lesson], at).some((h) => h.lessonId === lesson.id);

const MEMORY_INDEX = /(?:^|\/)projects\/[^/]+\/memory\/MEMORY\.md$/;
// Claude Code loads only the first 200 lines or 25 KB of MEMORY.md at start; topic files are read on demand.
const loadedIndex = (bytes) => fold(bytes.subarray(0, 25 * 1024)).split('\n').slice(0, 200).join('\n');

/** Chain `shown` before the session (prereg 180): the phrase in an instruction file or the loaded part of a MEMORY.md. */
export function shownAtStart(lesson, { root, surfaces }) {
  const phrase = fold(lesson.keyPhrase);
  for (const { key, e, bytes } of surfaceBytes(root, surfaces, ['instructions', 'userInstructions', 'autoMemory'])) {
    if (key === 'autoMemory' && !MEMORY_INDEX.test(e.path)) continue;
    if ((key === 'autoMemory' ? loadedIndex(bytes) : fold(bytes)).includes(phrase)) return true;
  }
  return false;
}

/** Chain `captured` (prereg 182): a store entry holding the phrase or the rule; `captured` leaves out imported agent notes. */
export function capturedBy(lesson, stores) {
  const hit = (e) => holds(e.content, lesson.keyPhrase) || holds(collapse(e.content), collapse(lesson.rule));
  const entries = stores.flatMap((s) => s.entries).filter(hit);
  return { captured: entries.some((e) => !isImported(e)), capturedAny: entries.length > 0 };
}

const sequenceLessons =(spec, sequenceId) => (spec.families ?? []).filter((f) => f.sequence === sequenceId).flatMap((f) => f.lessons ?? []);

/** Preflight: refuse a lesson text or a flagged prompt that would leak another lesson's key phrase in any order. */
export function assertNoPhraseLeaks(spec) {
  for (const s of spec.sequences) {
    const lessons = sequenceLessons(spec, s.id);
    for (const holder of lessons) {
      // A reversal's teach always follows its root's, so naming the root is no leak.
      for (const l of lessons.filter((x) => x !== holder && x.id !== holder.supersedes)) {
        for (const f of ['rule', 'reason']) {
          if (holds(holder[f], l.keyPhrase)) throw new Error(`lesson ${holder.id}: its ${f} holds lesson ${l.id}'s key phrase "${l.keyPhrase}", so its teach would leak ${l.id}`);
        }
      }
    }
    for (const t of s.tasks.filter((x) => x.keyPhraseAllowed)) {
      const l = lessons.find((x) => x.id !== t.lessonId && holds(t.prompt, x.keyPhrase));
      if (l) throw new Error(`task ${s.id}/${t.id}: keyPhraseAllowed covers only the task's own lesson, but its prompt holds lesson ${l.id}'s key phrase "${l.keyPhrase}"`);
    }
  }
}

/** Refuse a task whose stub tree holds any of its sequence's key phrases. */
export function assertNoPhraseInStub(spec, cacheDir, sequenceId, t, stub) {
  for (const l of sequenceLessons(spec, sequenceId)) {
    const r = gitSpawn(['grep', '-z', '-l', '-i', '-F', '-e', l.keyPhrase, stub], cacheDir);
    if (r.status === 1) continue;
    if (r.status !== 0) throw new Error(`git grep for lesson ${l.id}'s key phrase failed in ${cacheDir}: ${String(r.stderr).trim()}`);
    const files = String(r.stdout).split('\0').filter(Boolean).map((p) => p.slice(stub.length + 1));
    throw new Error(`Z0 task ${sequenceId}/${t.id}: the stub tree holds lesson ${l.id}'s key phrase "${l.keyPhrase}" in ${files.join(', ')}; pick another task or key phrase`);
  }
}
