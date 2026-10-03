// Task workspaces: the stub CLAUDE.md base, checkout without the future, and the instruction-file carry (prereg line 80).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { git, gitSpawn } from './exec.mjs';
import { HIPPO_ARMS } from './arms.mjs';

export const STUB_CLAUDE_MD = '# Instructions for coding agents working in this repository.\n';
const STUB_IDENT = {
  GIT_AUTHOR_NAME: 'z0-eval', GIT_AUTHOR_EMAIL: 'z0-eval@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'z0-eval', GIT_COMMITTER_EMAIL: 'z0-eval@localhost', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
const NAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
const SKIP_DIRS = new Set(['.git', '.hippo', 'node_modules']);
const win = process.platform === 'win32';

/** The base plus a root CLAUDE.md holding only the stub; fixed identity and dates give every arm the same sha. */
export function stubBaseCommit(cacheDir, baseRef) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-stub-'));
  try {
    fs.writeFileSync(path.join(scratch, 'stub'), STUB_CLAUDE_MD);
    const blob = git(['hash-object', '-w', '--no-filters', path.join(scratch, 'stub')], cacheDir).trim();
    const env = { ...STUB_IDENT, GIT_INDEX_FILE: path.join(scratch, 'index') };
    const parent = git(['rev-parse', `${baseRef}^{commit}`], cacheDir).trim();
    git(['read-tree', parent], cacheDir, env);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},CLAUDE.md`], cacheDir, env);
    const tree = git(['write-tree'], cacheDir, env).trim();
    // --no-gpg-sign: a signing config would make the sha differ per run.
    return git(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'z0 eval: stub CLAUDE.md'], cacheDir, env).trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A CLAUDE.md, CLAUDE.local.md or AGENTS.md at any depth, or a file under the root .claude/rules/; nothing else under .claude/. */
export function isInstructionPath(rel) {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
  if (parts[0] === '.claude') return parts[1] === 'rules' && parts.length > 2;
  if (parts.includes('.claude')) return false;
  return NAMES.has(parts[parts.length - 1]);
}

const isLink = (file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;

/** Every instruction file on disk as `{path: bytes}`, forward-slash paths; read from disk so git filters never enter. */
export function instructionSnapshot(workDir) {
  const snap = new Map();
  const walk = (rel) => {
    // On POSIX an agent can delete its own work dir; a missing dir holds no instruction files, so the carry reads every one as deleted.
    for (const e of list(path.join(workDir, rel))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
      } else if (e.isFile() && isInstructionPath(child)) snap.set(child, fs.readFileSync(path.join(workDir, child)));
    }
  };
  walk('');
  return snap;
}

/** Blob entries in a commit's tree as `[mode, path]` (gitlinks dropped). */
function treeBlobs(workDir, commit) {
  return git(['ls-tree', '-r', '-z', '--full-tree', commit], workDir).split('\0').filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([meta]) => meta.split(' ')[1] === 'blob')
    .map(([meta, rel]) => [meta.split(' ')[0], rel]);
}

/** Instruction paths in a commit's tree (gitlinks dropped). */
export function baseInstructionSet(workDir, commit) {
  return treeBlobs(workDir, commit).map(([, rel]) => rel).filter(isInstructionPath);
}

/** Throws when the stub tree a task checks out holds an instruction file, or .claude or anything under it, as a symlink. */
export function assertNoInstructionLinks(cacheDir, sequenceId, t, stub) {
  // A link's bytes are its target path and an edit through it lands on a non-instruction file, so neither carry nor restore can keep it.
  const inClaude = (rel) => rel === '.claude' || rel.startsWith('.claude/');
  const link = treeBlobs(cacheDir, stub).find(([mode, rel]) => mode === '120000' && (isInstructionPath(rel) || inClaude(rel)));
  if (link) throw new Error(`Z0 task ${sequenceId}/${t.id}: ${inClaude(link[1]) ? '.claude entry' : 'instruction file'} ${link[1]} is a symlink in the task repo; Z0 does not carry symlinked instruction files, pick another task`);
}

function assertInstructionSet(workDir, commit) {
  const norm = (paths) => new Set([...paths].map((p) => (win ? p.toLowerCase() : p)));
  const tree = norm(baseInstructionSet(workDir, commit));
  const disk = norm(instructionSnapshot(workDir).keys());
  const extra = [...disk].filter((p) => !tree.has(p));
  const missing = [...tree].filter((p) => !disk.has(p));
  if (extra.length || missing.length) throw new Error(`instruction files in ${workDir} differ from base ${commit}: extra [${extra.join(', ')}], missing [${missing.join(', ')}]`);
}

const WORK_CONFIG = [['user.email', 'eval@localhost'], ['user.name', 'eval'], ['core.autocrlf', 'false'], ['core.eol', 'lf'], ['core.longpaths', 'true']];
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const LOCKED = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const GONE = new Set(['ENOENT', 'ENOTDIR']);

/** fn's result, or `absent` when the path vanished after the purge listed it. */
function unlessGone(fn, absent) {
  // A detached hippo SessionEnd worker can still be closing SQLite, which deletes hippo.db-wal and hippo.db-shm.
  try {
    return fn();
  } catch (e) {
    if (GONE.has(e.code)) return absent;
    throw e;
  }
}

/** rmSync, retried for about 11 seconds while a file stays locked, then a throw naming the locked path. */
function rm(p) {
  // A process the agent or the hidden tests left running can hold a file after it is told to stop, and rmSync's own maxRetries did not retry EPERM on Node 24.
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.rmSync(p, { recursive: true, force: true });
    } catch (e) {
      // A path that vanished is removed; one whose child vanished mid-removal is retried.
      if (GONE.has(e.code) && unlessGone(() => fs.lstatSync(p), null) === null) return;
      if (attempt > 10 || !(LOCKED.has(e.code) || GONE.has(e.code))) throw new Error(`Z0 workspace: cannot remove ${e.path ?? p} (${e.code ?? e.message}); a process left running from the last session may still hold it`, { cause: e });
      Atomics.wait(SLEEP, 0, 0, attempt * 200);
    }
  }
}

// NTFS and Git for Windows match names in any case, so OBJECTS or .GIT is a repo piece there too.
const fold = (name) => (win ? name.toLowerCase() : name);
// Hippo's store never uses these names (src/store.ts), so in a kept .hippo each marks a repo or a piece of one.
const GIT_NAMES = new Set(['.git', 'objects', 'refs', 'packed-refs', 'HEAD', 'commondir', 'gitdir'].map(fold));
const holdsRepo = (entries) => entries.some((e) => ['.git', 'objects', 'commondir', 'gitdir'].includes(fold(e.name)));
const GIT_MAGIC = ['# v2 git bundle', '# v3 git bundle', 'PACK\0\0\0\x02', 'PACK\0\0\0\x03'].map((s) => Buffer.from(s, 'latin1'));
const list = (dir) => unlessGone(() => fs.readdirSync(dir, { withFileTypes: true }), []);

/** True for a git bundle or pack file, which clones or unpacks back to the history under any name. */
function isGitArchive(file) {
  const head = Buffer.alloc(16);
  const fd = unlessGone(() => fs.openSync(file, 'r'), null);
  if (fd === null) return false;
  try {
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return GIT_MAGIC.some((m) => n >= m.length && head.subarray(0, m.length).equals(m));
  } finally {
    fs.closeSync(fd);
  }
}

/** Delete every git repo, bundle, pack and link under a kept dir: below the top a repo's whole dir, at the top only its git entries. */
function dropRepos(dir, top) {
  let entries = list(dir);
  if (holdsRepo(entries)) {
    if (!top) return rm(dir);
    for (const e of entries) if (GIT_NAMES.has(fold(e.name))) rm(path.join(dir, e.name));
    entries = list(dir);
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // Hippo never makes links, and Dirent.isDirectory is false for one, so a link is removed and never followed.
    if (e.isSymbolicLink()) rm(p);
    else if (e.isDirectory()) dropRepos(p, false);
    else if (e.isFile() && isGitArchive(p)) rm(p);
  }
}

/** Empty the workspace but for the arm's own store, so nothing an agent wrote survives except what E3's surface check reads. */
function emptyWorkspace(workDir, arm) {
  // Emptying a work dir the agent swapped for a link would delete the link target's files, and one it deleted must not abandon the run.
  if (!fs.lstatSync(workDir, { throwIfNoEntry: false })?.isDirectory()) {
    rm(workDir);
    fs.mkdirSync(workDir, { recursive: true });
  }
  const keep = HIPPO_ARMS.has(arm) ? new Set(['.hippo']) : new Set();
  // Git's own rules (excludes, gitlinks, -ff) are what let agent clones and submodule dirs outlive a clean, so the runner names what stays.
  for (const e of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (keep.has(e.name) && e.isDirectory()) dropRepos(path.join(workDir, e.name), true);
    else rm(path.join(workDir, e.name));
  }
}

/** Move the workspace to a task's stub base without its future, in a new .git that fetches only that commit's history. */
export function checkoutBase(cacheDir, workDir, sequenceId, t, arm) {
  const stub = stubBaseCommit(cacheDir, t.baseRef);
  assertNoInstructionLinks(cacheDir, sequenceId, t, stub);
  // Sequence order comes from the seed, so an earlier base can hold a later task's fix.
  emptyWorkspace(workDir, arm);
  git(['init', '--quiet'], workDir);
  for (const [k, v] of WORK_CONFIG) git(['config', k, v], workDir);
  // Keeps a hippo arm's store out of `git status`.
  fs.appendFileSync(path.join(workDir, '.git', 'info', 'exclude'), '\n.hippo/\n');
  const ref = `refs/eval/${sequenceId}/${t.id}`;
  git(['update-ref', ref, stub], cacheDir);
  git(['fetch', '--quiet', '--no-tags', cacheDir, `+${ref}:refs/remotes/eval/base`], workDir);
  git(['checkout', '--quiet', '-f', '--detach', 'refs/remotes/eval/base'], workDir);
  assertInstructionSet(workDir, stub);
  return stub;
}

/** Paths whose bytes differ between two snapshots, as `{before, after}` (null for absent). */
export function instructionDelta(baseline, end) {
  const delta = new Map();
  for (const p of new Set([...baseline.keys(), ...end.keys()])) {
    const before = baseline.get(p) ?? null;
    const after = end.get(p) ?? null;
    if (!same(before, after)) delta.set(p, { before, after });
  }
  return delta;
}

const same = (a, b) => (a === null || b === null ? a === b : a.equals(b));

function writeFile(workDir, rel, bytes) {
  // writeHiddenTests runs with no checkout after the session, so an agent's link at the path or any parent would send the write outside the workspace.
  const parts = rel.split(/[\\/]/);
  for (let i = 0; i <= parts.length; i++) {
    const p = path.join(workDir, ...parts.slice(0, i));
    if (isLink(p)) rm(p);
  }
  const file = path.join(workDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

/** Three-way merge of the agent's version onto the new base; a conflict falls back to --union. */
function mergeFile(rel, after, before, now, tmpRoot) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'merge-'));
  try {
    const files = [['current', after], ['base', before ?? Buffer.alloc(0)], ['other', now]].map(([name, bytes]) => {
      fs.writeFileSync(path.join(dir, name), bytes);
      return path.join(dir, name);
    });
    const merge = (extra) => gitSpawn(['merge-file', '-p', ...extra, ...files], dir);
    const first = merge([]);
    if (first.status === 0) return { bytes: first.stdout, union: false };
    if (first.status >= 1 && first.status <= 127) {
      const union = merge(['--union']);
      if (union.status === 0) return { bytes: union.stdout, union: true };
    }
    throw new Error(`cannot carry ${rel}: git merge-file exited ${first.status}${first.signal ? ` (${first.signal})` : ''}: ${String(first.stderr ?? first.error ?? '').trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Apply the carried change set onto the new baseline; returns the carry counts for the record. */
export function applyInstructions(workDir, changes, baseline, tmpRoot) {
  const counts = { carryMerges: 0, carryUnionMerges: 0, carryDeleteKept: 0 };
  for (const [rel, { before, after }] of changes) {
    const now = baseline.get(rel) ?? null;
    if (after === null) {
      if (now === null) continue;
      if (same(now, before)) fs.rmSync(path.join(workDir, rel));
      else counts.carryDeleteKept++;
    } else if (now === null || same(now, before)) {
      writeFile(workDir, rel, after);
    } else {
      const merged = mergeFile(rel, after, before, now, tmpRoot);
      writeFile(workDir, rel, merged.bytes);
      counts[merged.union ? 'carryUnionMerges' : 'carryMerges']++;
    }
  }
  return counts;
}

/** Put the instruction files back exactly as a snapshot holds them, deleting any it lacks. */
export function restoreInstructions(workDir, snap) {
  for (const rel of instructionSnapshot(workDir).keys()) if (!snap.has(rel)) fs.rmSync(path.join(workDir, rel));
  for (const [rel, bytes] of snap) writeFile(workDir, rel, bytes);
}

/** Write the task's hidden test files from fixRef, read from the cache clone. */
export function writeHiddenTests(cacheDir, workDir, t) {
  for (const f of t.testFiles) writeFile(workDir, f, git(['show', `${t.fixRef}:${f}`], cacheDir, {}, 'buffer'));
}

/** Added lines of a task's gold diff that are long enough to be a leak signal. */
export function goldLines(cacheDir, t) {
  // A git error throws: an empty list would silently turn the leak check off for the task.
  return git(['diff', '--no-ext-diff', '--no-color', '--no-textconv', t.baseRef, t.fixRef], cacheDir).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l.length >= 40);
}
