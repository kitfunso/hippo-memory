// G1 (prereg 113, 159-162): a session that read past its own cell, or was handed memory its arm must not hold, is void.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HIPPO_ARMS } from './arms.mjs';
import { toolInputs, toolResultTexts, hookContexts } from './records.mjs';

/** Void reasons in precedence order: the record's `void` is the first one hit. */
export const VOID_ORDER = ['operator-canary', 'read', 'auto-memory', 'user-instructions', 'hippo-text'];
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];
const FLOOR_ARMS = new Set(['A0', 'A4']);
const HIPPO_MARK = '<!-- hippo:start -->';
const ENV_FORM = /\$\{?\w+\}?|\$env:\w+|%\w+%/i;
const TOKEN = /"([^"]*)"|'([^']*)'|([^\s"'<>()]+)/g;
const SEARCH_ALWAYS = new Set(['rg', 'ag', 'ack', 'find', 'fd', 'tree', 'du']);
const GREP_R = /^-[a-z]*r|^--(?:dereference-)?recursive$/i;
const PS_R = /^-r(?:ecurse)?$/i;
const RECURSIVE_FLAG = { grep: GREP_R, egrep: GREP_R, fgrep: GREP_R, ls: /^-[a-zA-Z]*R|^--recursive$/, 'get-childitem': PS_R, gci: PS_R, dir: /^(?:-r(?:ecurse)?|[-/]s)$/i };
const WILDCARD_SEARCH = new Set(['select-string', 'sls']);
const CD = new Set(['cd', 'pushd', 'set-location', 'sl', 'chdir']);
const READ_KEYS = { Read: 'file_path', NotebookRead: 'notebook_path', NotebookEdit: 'notebook_path', LS: 'path', Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path' };

function envValue(env, name, win) {
  const key = Object.keys(env).find((k) => (win ? k.toUpperCase() === name.toUpperCase() : k === name));
  return key === undefined ? undefined : env[key];
}

/** A path token as the agent's shell sees it: env forms expanded, a Git Bash drive path mapped on win32, resolved against cwd, forward slashes. */
export function resolveToken(token, { env, cwd, platform }) {
  const win = platform === 'win32';
  const known = (name) => (ENV_KEYS.includes(win ? name.toUpperCase() : name) ? envValue(env, name, win) : undefined);
  const sub = (whole, name) => known(name) ?? whole;
  let p = token
    .replace(/^~(?=$|[\\/])/, () => known('HOME') ?? (win ? known('USERPROFILE') : undefined) ?? '~')
    .replace(/\$env:(\w+)/gi, sub)
    .replace(/\$\{(\w+)\}/g, sub)
    .replace(/\$(\w+)/g, sub)
    .replace(/%(\w+)%/g, sub);
  // The agent's shell is Git Bash (homes.mjs), where /c/x is C:/x.
  if (win) p = p.replace(/^\/([a-zA-Z])(?:\/|$)/, (_, d) => `${d.toUpperCase()}:/`);
  const resolved = (win ? path.win32 : path.posix).resolve(cwd, p);
  return win ? resolved.replaceAll('\\', '/') : resolved;
}

/** A search or glob root: the path up to the directory holding its first wildcard. */
function cutWildcard(p) {
  const wild = p.search(/[*?[]/);
  return wild < 0 ? p : p.slice(0, p.lastIndexOf('/', wild) + 1) || p.slice(0, wild);
}

/** Path tokens of a shell command as `{token, search, cwd}`; a `cd` target counts as a read and moves cwd for the rest of the command. */
function shellPaths(command, work, opts) {
  const out = [];
  let cwd = work;
  for (const seg of String(command ?? '').split(/&&|\|\||[;|&\n]/)) {
    const words = [...seg.matchAll(TOKEN)].map((m) => m[1] ?? m[2] ?? m[3]);
    const cmd = (words[0] ?? '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    const args = words.slice(1).filter((a) => !a.startsWith('-'));
    const flags = words.slice(1).filter((a) => a.startsWith('-') || a.startsWith('/'));
    const search = SEARCH_ALWAYS.has(cmd) || flags.some((a) => RECURSIVE_FLAG[cmd]?.test(a)) || (WILDCARD_SEARCH.has(cmd) && args.some((a) => a.includes('*')));
    if (CD.has(cmd) && args[0]) {
      out.push({ token: args[0], search: false, cwd });
      cwd = resolveToken(args[0], { ...opts, cwd });
      continue;
    }
    const kept = words.filter((a, i) => !a.startsWith('-') && (/[\\/]/.test(a) || a.startsWith('~') || ENV_FORM.test(a) || (search && i > 0 && (a === '.' || a === '..'))));
    for (const token of kept) out.push({ token, search: search && token !== words[0], cwd });
    // A search with no path searches cwd, which a cd may have moved.
    if (search && !kept.some((a) => a !== words[0])) out.push({ token: '.', search: true, cwd });
  }
  return out;
}

/** Every path a tool call names, as `{token, search, cwd}`. */
function toolPaths(name, input, work, opts) {
  if (name === 'Bash' || name === 'PowerShell') return shellPaths(input.command, work, opts);
  if (name === 'Grep') return [{ token: input.path ?? '.', search: true, cwd: work }];
  if (name === 'Glob') {
    const root = resolveToken(input.path ?? '.', { ...opts, cwd: work });
    return [{ token: root, search: true, cwd: work }, ...(input.pattern ? [{ token: input.pattern, search: true, cwd: root }] : [])];
  }
  const key = READ_KEYS[name];
  return key && input[key] ? [{ token: String(input[key]), search: false, cwd: work }] : [];
}

/** The cell's bounds, folded for comparison (case-insensitive on win32). */
function bounds(ctx, run, step, ownIds) {
  const win = process.platform === 'win32';
  const fold = (p) => {
    const s = path.resolve(p).replaceAll('\\', '/');
    return (win ? s.toLowerCase() : s).replace(/(?<=.)\/+$/, '');
  };
  const d = run.dirs;
  const homes = [...new Set(['HOME', 'USERPROFILE'].map((k) => envValue(run.env, k, win)).filter(Boolean))];
  const appData = envValue(run.env, 'APPDATA', win);
  const operator = [...homes.flatMap((h) => ['.claude', '.codex', '.hippo'].map((s) => path.join(h, s))), ...(appData ? [path.join(appData, 'Claude')] : [])].map(fold);
  return {
    win, fold, operator, cache: fold(ctx.cacheDir), out: fold(ctx.outDir), root: fold(d.root), config: fold(d.claudeConfig), codex: fold(d.codexHome),
    projects: fold(path.join(d.claudeConfig, 'projects')), own: [d.work, d.claudeConfig, d.codexHome, d.hippoHome, d.bin].map(fold),
    ownIds: new Set(ownIds.map((id) => (win ? id.toLowerCase() : id))),
    foreign: ctx.foreignDirs.filter((f) => f.order < step.order).map((f) => fold(f.path)),
    // A recursive search from an ancestor of any of these reads past transcripts, other runs or operator memory (162).
    searchRoots: [fold(path.join(d.claudeConfig, 'projects')), fold(d.codexHome), fold(path.dirname(d.root)), ...operator],
  };
}

const under = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
const relTo = (root, p) => (p === root ? '' : p.slice(root.length + 1));

/** Files under claude-config a session may read: its arm's memory and instructions, and its own transcripts. */
function ownConfig(b, p) {
  const rel = relTo(b.config, p);
  if (/^projects\/[^/]+\/memory(?:\/|$)|^claude\.md$|^rules(?:\/|$)|^settings[^/]*\.json$/i.test(rel)) return true;
  const m = /^projects\/[^/]+\/([^/]+?)(?:\.jsonl)?(?:\/|$)/i.exec(rel);
  return Boolean(m && b.ownIds.has(m[1]));
}

/** The first class a resolved path falls in (plan section 4, revisions 11 and 13), or null when the read is allowed. */
function classify(b, p, search) {
  if (under(p, b.cache)) return 'other-arm';
  if (under(p, b.config) && !ownConfig(b, p)) return 'past-transcript';
  if (under(p, b.codex) && !/^(?:memories(?:\/|$)|config\.toml$)/i.test(relTo(b.codex, p))) return 'past-rollout';
  if (under(p, b.out) && !under(p, b.root)) return 'other-run';
  if (search && b.searchRoots.some((f) => under(f, p))) return 'ancestor-search';
  if (under(p, b.root) && !b.own.some((o) => under(p, o))) return 'outside-work';
  if (b.operator.some((o) => under(p, o))) return 'operator';
  return b.foreign.some((f) => under(p, f)) ? 'worktree' : null;
}

const hit = (reason, cls, tool, p, file) => ({ reason, class: cls, tool, path: p, file });

/** Delivery voids known at pre-session (159-161), from the surface snapshot and the instruction files on disk. */
export function deliveryHits(run, snap, preSession) {
  const s = snap.surfaces;
  const hits = [];
  const surfaceHit = (reason, key) => {
    if (s[key].length) hits.push(hit(reason, key, null, s[key][0].path, null));
  };
  if (FLOOR_ARMS.has(run.arm)) {
    surfaceHit('auto-memory', 'autoMemory');
    surfaceHit('user-instructions', 'userInstructions');
  }
  if (HIPPO_ARMS.has(run.arm)) return hits;
  surfaceHit('hippo-text', 'hippoWork');
  surfaceHit('hippo-text', 'hippoGlobal');
  for (const [rel, bytes] of preSession) if (bytes.includes(HIPPO_MARK)) hits.push(hit('hippo-text', 'instructions', null, `work/${rel}`, null));
  for (const e of s.userInstructions) {
    if (e.error || e.link) continue;
    if (fs.readFileSync(path.join(run.dirs.root, e.path)).includes(HIPPO_MARK)) hits.push(hit('hippo-text', 'userInstructions', null, e.path, null));
  }
  return hits;
}

/** Read hits from every tool call's paths, plus auto-memory hits for a floor arm whose tools touched a memory dir. */
function pathHits(run, b, files, fileName) {
  const opts = { env: run.env, platform: process.platform };
  const hits = [];
  for (const { file, name, input } of toolInputs(files)) {
    for (const { token, search, cwd } of toolPaths(name, input, run.dirs.work, opts)) {
      const p = b.fold(cutWildcard(resolveToken(token, { ...opts, cwd })));
      const cls = classify(b, p, search);
      if (cls) hits.push(hit('read', cls, name, p, fileName(file)));
      if (FLOOR_ARMS.has(run.arm) && /^[^/]+\/memory(?:\/|$)/i.test(under(p, b.projects) ? relTo(b.projects, p) : '')) hits.push(hit('auto-memory', 'tool-input', name, p, fileName(file)));
    }
  }
  return hits;
}

/** Hits from what the session saw: other sessions' transcript lines in tool results, canaries anywhere, hook-injected context. */
function contentHits(ctx, run, b, files, fileName) {
  const hits = [];
  for (const { file, text } of toolResultTexts(files)) {
    const ids = [...text.matchAll(/"sessionId"\s*:\s*"([^"]+)"/g)].map((m) => (b.win ? m[1].toLowerCase() : m[1]));
    if (ids.some((id) => !b.ownIds.has(id)) || /"type"\s*:\s*"session_meta"/.test(text)) hits.push(hit('read', 'transcript-content', null, null, fileName(file)));
  }
  for (const file of new Set(files)) {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    for (const c of ctx.canaries) if (raw.includes(c)) hits.push(hit('operator-canary', null, null, null, fileName(file)));
  }
  if (!HIPPO_ARMS.has(run.arm)) for (const { file } of hookContexts(files)) hits.push(hit('hippo-text', 'hook', null, null, fileName(file)));
  return hits;
}

/** The session's G1 verdict: `void` is the highest-precedence hit's reason; `voidHits` keeps every hit, in precedence order. */
export function sessionVoid(ctx, run, step, { files, ownIds, delivery }) {
  const b = bounds(ctx, run, step, ownIds);
  const fileName = (f) => path.relative(ctx.outDir, f).split(path.sep).join('/');
  const hits = [...delivery, ...pathHits(run, b, files, fileName), ...contentHits(ctx, run, b, files, fileName)];
  hits.sort((x, y) => VOID_ORDER.indexOf(x.reason) - VOID_ORDER.indexOf(y.reason));
  return { void: hits[0]?.reason ?? null, voidHits: hits };
}
