// Task workspaces: the stub CLAUDE.md base, checkout without the future, and the instruction-file carry (prereg line 80).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { git } from './exec.mjs';

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
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: cacheDir, input: STUB_CLAUDE_MD, encoding: 'utf8' }).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-index-'));
  const env = { ...process.env, ...STUB_IDENT, GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const parent = git(['rev-parse', `${baseRef}^{commit}`], cacheDir).trim();
    git(['read-tree', parent], cacheDir, env);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},CLAUDE.md`], cacheDir, env);
    const tree = git(['write-tree'], cacheDir, env).trim();
    // --no-gpg-sign: a signing config would make the sha differ per run.
    return git(['commit-tree', '--no-gpg-sign', tree, '-p', parent, '-m', 'z0 eval: stub CLAUDE.md'], cacheDir, env).trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

/** Instruction entries in a commit's tree as `[mode, path]` (gitlinks dropped). */
function treeInstructions(workDir, commit) {
  return git(['ls-tree', '-r', '-z', '--full-tree', commit], workDir).split('\0').filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([meta, rel]) => meta.split(' ')[1] === 'blob' && isInstructionPath(rel))
    .map(([meta, rel]) => [meta.split(' ')[0], rel]);
}

/** Instruction paths in a commit's tree (gitlinks dropped). */
export function baseInstructionSet(workDir, commit) {
  return treeInstructions(workDir, commit).map(([, rel]) => rel);
}

/** Throws when a task's base tree holds an instruction file as a symlink. */
export function assertNoInstructionLinks(cacheDir, sequenceId, t) {
  // A link's bytes are its target path and an edit through it lands on a non-instruction file, so neither carry nor restore can keep it.
  const link = treeInstructions(cacheDir, t.baseRef).find(([mode]) => mode === '120000');
  if (link) throw new Error(`Z0 task ${sequenceId}/${t.id}: instruction file ${link[1]} is a symlink in the task repo; Z0 does not carry symlinked instruction files, pick another task`);
}

function assertInstructionSet(workDir, commit) {
  const norm = (paths) => new Set([...paths].map((p) => (win ? p.toLowerCase() : p)));
  const tree = norm(baseInstructionSet(workDir, commit));
  const disk = norm(instructionSnapshot(workDir).keys());
  const extra = [...disk].filter((p) => !tree.has(p));
  const missing = [...tree].filter((p) => !disk.has(p));
  if (extra.length || missing.length) throw new Error(`instruction files in ${workDir} differ from base ${commit}: extra [${extra.join(', ')}], missing [${missing.join(', ')}]`);
}

/** Move the workspace to a task's stub base without its future: the workspace fetches only a ref at that commit. */
export function checkoutBase(cacheDir, workDir, sequenceId, t) {
  assertNoInstructionLinks(cacheDir, sequenceId, t);
  const stub = stubBaseCommit(cacheDir, t.baseRef);
  const ref = `refs/eval/${sequenceId}/${t.id}`;
  git(['update-ref', ref, stub], cacheDir);
  git(['fetch', '--quiet', '--no-tags', cacheDir, `+${ref}:refs/remotes/eval/base`], workDir);
  git(['checkout', '--quiet', '-f', '--detach', 'refs/remotes/eval/base'], workDir);
  // -x also removes gitignored leftovers such as agent notes, so A0 is a true floor.
  git(['clean', '-fdqx', '-e', '.hippo', '-e', 'node_modules'], workDir);
  // An agent's stash, branch, tag or note keeps an earlier base reachable, and is a memory channel even in A0.
  const stale = git(['for-each-ref', '--format=%(refname)'], workDir).split('\n').filter((r) => r && r !== 'refs/remotes/eval/base');
  for (const r of stale) git(['update-ref', '-d', r], workDir);
  // Sequence order comes from the seed, so an earlier base can hold a later task's fix: drop every commit the base cannot reach.
  git(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], workDir);
  git(['gc', '--quiet', '--prune=now'], workDir);
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
  // An agent can turn an instruction file into a link to a file outside the workspace; never write through it.
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
