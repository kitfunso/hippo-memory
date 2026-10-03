// G3 (prereg 164): a lesson's key phrase the agent could read before that lesson's teach voids the (sequence, seed).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { gitSpawn } from './exec.mjs';
import { agentGit } from './checks.mjs';
import { RESTORABLE } from './surfaces.mjs';
import { ownsPhrase } from './lessons.mjs';

// Bytes as latin1 with ASCII-only case folding, so a non-ASCII phrase matches its exact UTF-8 bytes.
const fold = (data) => Buffer.from(data).toString('latin1').replace(/[A-Z]+/g, (m) => m.toLowerCase());
const holds = (text, phrase) => fold(text).includes(fold(phrase));

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

/** Every place an open lesson's key phrase sits before the session, as `{lessonId, surface, path}`; an archive hit names no lesson. */
export function findLeaks(open, { t, root, work, pre, surfaces, stores }) {
  if (!open.length) return [];
  const phrases = open.map((l) => ({ id: l.id, raw: l.keyPhrase, folded: fold(l.keyPhrase) }));
  const hits = [];
  const scan = (text, surface, at) => {
    for (const p of phrases) if (text.includes(p.folded)) hits.push({ lessonId: p.id, surface, path: at });
  };
  for (const key of [...RESTORABLE, 'instructions']) {
    for (const e of surfaces[key] ?? []) {
      const bytes = e.error ? null : readOrNull(path.join(root, e.path));
      if (!bytes) continue;
      const text = searchable(bytes);
      if (text === null) hits.push({ lessonId: null, surface: `${key}-archive`, path: e.path });
      else scan(text, key, e.path);
    }
  }
  for (const s of stores) for (const e of s.entries) scan(fold(e.content), s.surface, `${s.path}#${e.id}`);
  for (const p of phrases) for (const rel of workspaceFiles(work, pre, p.raw)) hits.push({ lessonId: p.id, surface: 'workspace', path: `work/${rel}` });
  for (const l of open) if (!ownsPhrase(t, l) && holds(t.prompt, l.keyPhrase)) hits.push({ lessonId: l.id, surface: 'prompt', path: null });
  return hits;
}

const sequenceLessons = (spec, sequenceId) => (spec.families ?? []).filter((f) => f.sequence === sequenceId).flatMap((f) => f.lessons ?? []);

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
