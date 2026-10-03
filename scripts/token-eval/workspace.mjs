// Task workspaces: the stub CLAUDE.md base, checkout without the future, and the instruction-file carry (prereg line 80).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { git } from './exec.mjs';
import { HIPPO_ARMS } from './arms.mjs';

export const STUB_CLAUDE_MD = '# Instructions for coding agents working in this repository.\n';
const STUB_IDENT = {
  GIT_AUTHOR_NAME: 'z0-eval', GIT_AUTHOR_EMAIL: 'z0-eval@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'z0-eval', GIT_COMMITTER_EMAIL: 'z0-eval@localhost', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};
const NAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
const SKIP_DIRS = new Set(['.git', '.hippo', 'node_modules']);
const win = process.platform === 'win32';

/** Runs fn(rgit, scratch) with a git that reads no system or global config and runs no hooks. */
function withRunnerGit(fn) {
  // The agent shares the operator's HOME, so its global config could add hooks, an fsmonitor or a commit encoding to runner calls.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-git-'));
  const hooks = path.join(scratch, 'hooks');
  fs.mkdirSync(hooks);
  // Git for Windows reads /dev/null as the null device; os.devNull (\\.\nul) it refuses.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const rgit = (args, cwd, extra = {}) => git(['-c', `core.hooksPath=${hooks}`, '-c', 'core.longpaths=true', ...args], cwd, { ...env, ...extra });
  try {
    return fn(rgit, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The base plus a root CLAUDE.md holding only the stub; fixed identity and dates give every arm the same sha. */
export function stubBaseCommit(cacheDir, baseRef) {
  return withRunnerGit((rgit, scratch) => {
    fs.writeFileSync(path.join(scratch, 'stub'), STUB_CLAUDE_MD);
    const blob = rgit(['hash-object', '-w', '--no-filters', path.join(scratch, 'stub')], cacheDir).trim();
    const env = { ...STUB_IDENT, GIT_INDEX_FILE: path.join(scratch, 'index') };
    const parent = rgit(['rev-parse', `${baseRef}^{commit}`], cacheDir).trim();
    rgit(['read-tree', parent], cacheDir, env);
    rgit(['update-index', '--add', '--cacheinfo', `100644,${blob},CLAUDE.md`], cacheDir, env);
    const tree = rgit(['write-tree'], cacheDir, env).trim();
    // --no-gpg-sign: a signing config would make the sha differ per run.
    return rgit(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'z0 eval: stub CLAUDE.md'], cacheDir, env).trim();
  });
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
    for (const e of fs.readdirSync(path.join(workDir, rel), { withFileTypes: true })) {
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
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });

const holdsRepo = (names) => names.has('.git') || (names.has('HEAD') && names.has('objects') && names.has('refs'));

/** Delete every git repo under a kept dir: below the top the whole dir, at the top only its git entries. */
function dropRepos(dir, top) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (holdsRepo(new Set(entries.map((e) => e.name)))) {
    if (!top) return rm(dir);
    for (const name of ['.git', 'objects', 'refs']) rm(path.join(dir, name));
  }
  // Dirent.isDirectory is false for a link or junction, so the walk never leaves the workspace.
  for (const e of entries) if (e.isDirectory() && fs.existsSync(path.join(dir, e.name))) dropRepos(path.join(dir, e.name), false);
}

/** Empty the workspace but for the arm's own store, so nothing an agent wrote survives except what E3's surface check reads. */
function emptyWorkspace(workDir, arm) {
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
  withRunnerGit((rgit) => {
    rgit(['init', '--quiet'], workDir);
    for (const [k, v] of WORK_CONFIG) rgit(['config', k, v], workDir);
    // Keeps a hippo arm's store out of `git status`.
    fs.appendFileSync(path.join(workDir, '.git', 'info', 'exclude'), '\n.hippo/\n');
    const ref = `refs/eval/${sequenceId}/${t.id}`;
    rgit(['update-ref', ref, stub], cacheDir);
    rgit(['fetch', '--quiet', '--no-tags', cacheDir, `+${ref}:refs/remotes/eval/base`], workDir);
    rgit(['checkout', '--quiet', '-f', '--detach', 'refs/remotes/eval/base'], workDir);
  });
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
  const file = path.join(workDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // writeHiddenTests runs with no checkout after the session, so an agent's link at a test path would send the write outside the workspace.
  if (isLink(file)) fs.rmSync(file);
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
    const merge = (extra) => spawnSync('git', ['merge-file', '-p', ...extra, ...files], { cwd: dir, maxBuffer: 1 << 28 });
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
  for (const f of t.testFiles) writeFile(workDir, f, execFileSync('git', ['show', `${t.fixRef}:${f}`], { cwd: cacheDir, maxBuffer: 1 << 28 }));
}

/** Added lines of a task's gold diff that are long enough to be a leak signal. */
export function goldLines(cacheDir, t) {
  // A git error throws: an empty list would silently turn the leak check off for the task.
  return git(['diff', t.baseRef, t.fixRef], cacheDir).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l.length >= 40);
}
