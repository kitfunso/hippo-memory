// X2's hippo install for Codex, hermetic per run (E6 plan D7, R1, R5, R11): the install env, the lookup probe, the operator launcher guard.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, HIPPO_JS, pathKey, sh } from './exec.mjs';
import { childEnv } from './arms.mjs';
import { WRAPPER_MARK, resolveCodex, writeLauncher } from './codex.mjs';

const WIN = process.platform === 'win32';
const ENV_KEYS = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
const WRAPPER_JS = path.join(REPO, 'dist', 'hooks', 'codex-wrapper.js');
// Hippo's own lookup and metadata path, run in the install's env, so the probe cannot drift from what the install will do.
const PROBE = 'import(process.argv[1]).then((m) => console.log(JSON.stringify({ found: m.detectRealCodexPath(), meta: m.resolveCodexWrapperPaths().metadataPath })))';
const HOOK_MARKS = { UserPromptSubmit: 'hippo context --pinned-only', SessionStart: 'hippo compact-resume' };
const REFUSED = 'nothing was installed, and the run is abandoned';

const same = (a, b) => Boolean(a) && (WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const whereOf = (run) => `${run.s.id} ${run.arm} seed${run.seed}`;
const metaFileOf = (run) => path.join(run.dirs.home, '.hippo', 'integrations', 'codex.json');
const digest = (file, isLink) => (isLink ? `link:${fs.readlinkSync(file)}` : createHash('sha256').update(fs.readFileSync(file)).digest('hex'));

/** The install's env: one PATH key holding only the run's bin/ and node's dir, HOME and APPDATA under `<root>/home` (plan R5, R11). */
export function installEnv(run) {
  // Two PATH spellings in a Windows child env give an undefined winner, so every spelling goes and one comes back.
  const env = Object.fromEntries(Object.entries(childEnv(run.env)).filter(([k]) => !ENV_KEYS.has(k.toUpperCase())));
  const home = run.dirs.home;
  const appdata = path.join(home, 'appdata');
  const installPath = `${run.dirs.bin}${path.delimiter}${path.dirname(process.execPath)}`;
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: appdata, [pathKey(process.env)]: installPath };
}

/** Refuses unless hippo's lookup, run in the install's env, finds the run launcher and no wrapper metadata under the run's home (plan R5). */
export function assertInstallProbe(run, env) {
  const where = whereOf(run);
  const r = spawnSync(process.execPath, ['-e', PROBE, pathToFileURL(WRAPPER_JS).href], { cwd: run.dirs.work, env, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`${where}: the Codex install probe exited ${r.status} (${(r.stderr ?? '').trim().slice(-300)}); run \`npm run build\` if dist/ is stale; ${REFUSED}`);
  const { found, meta } = JSON.parse(r.stdout);
  const want = metaFileOf(run);
  if (!same(meta, want)) throw new Error(`${where}: hippo would keep its Codex wrapper metadata at ${meta}, outside the run's home ${run.dirs.home}; ${REFUSED}`);
  if (fs.existsSync(want)) throw new Error(`${where}: ${want} already exists, so hippo would not wrap this run's launcher; ${REFUSED}`);
  if (!same(found, run.codexLauncher)) throw new Error(`${where}: hippo's install would wrap ${found ?? 'no codex at all'}, not the run launcher ${run.codexLauncher}; ${REFUSED}`);
}

/** Every `codex*` entry in the operator launcher dir with its hash; npm's POSIX shim is a symlink, kept as its target. */
function launcherState(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => /^codex/i.test(e.name) && !e.isDirectory());
  return new Map(entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((e) => [e.name, digest(path.join(dir, e.name), e.isSymbolicLink())]));
}

const changedNames = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((n) => a.get(n) !== b.get(n)).sort();

/** The operator's launcher dir as it was: new `codex*` entries removed, changed or missing ones written back from the copies. */
function restoreLaunchers(dir, before, copies) {
  for (const name of changedNames(before, launcherState(dir))) {
    const file = path.join(dir, name);
    const was = before.get(name);
    fs.rmSync(file, { force: true });
    if (was?.startsWith('link:')) fs.symlinkSync(was.slice(5), file);
    else if (was) fs.copyFileSync(path.join(copies, name), file);
  }
}

/** Puts the dir back and says how that went; the copies stay when the restore did not hold, since they are then the only good bytes. */
function putBack(dir, before, copies) {
  let failed = null;
  try {
    restoreLaunchers(dir, before, copies);
  } catch (err) {
    failed = err;
  }
  const left = changedNames(before, launcherState(dir));
  if (!failed && left.length === 0) {
    fs.rmSync(copies, { recursive: true, force: true });
    return 'they are put back byte for byte';
  }
  return `PUTTING THEM BACK FAILED for ${left.join(', ') || 'an unknown file'}${failed ? ` (${failed.message})` : ''}: copy the files in ${copies} over ${dir} by hand before you use codex again`;
}

/** fn() with the operator's launcher dir watched (plan R1, R5): a changed `codex*` file there is put back and the run abandoned. */
export function guardLaunchers(ctx, where, fn) {
  const dir = ctx.codexLauncher.dir;
  const before = launcherState(dir);
  // Beside the login vault, never inside it: closing the vault would delete the only good copies after a failed restore.
  const copies = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-codex-launchers-'));
  for (const [name, was] of before) if (!was.startsWith('link:')) fs.copyFileSync(path.join(dir, name), path.join(copies, name));
  let result;
  let failure = null;
  try {
    result = fn();
  } catch (err) {
    failure = err;
  }
  const changed = changedNames(before, launcherState(dir));
  if (changed.length) {
    const also = failure ? ` (the install also failed: ${failure.message})` : '';
    throw new Error(`${where}: the install changed the operator's Codex launchers in ${dir} (${changed.join(', ')}); ${putBack(dir, before, copies)}, and the run is abandoned${also}`);
  }
  fs.rmSync(copies, { recursive: true, force: true });
  if (failure) throw failure;
  return result;
}

/** The hippo CLI the wrapper runs must exist, else no Codex session of the run could start. */
export function assertWrapperRuns(launcher, where) {
  const cli = /["']([^"']+)["'] codex-run /.exec(fs.readFileSync(launcher, 'utf8'))?.[1];
  if (cli && fs.existsSync(cli)) return;
  throw new Error(`${where}: hippo's wrapper at ${launcher} runs ${cli ?? 'a hippo CLI this runner cannot read'}, which does not exist, so no Codex session of this run could start; fix the CLI path hippo's wrapper writes, run \`npm run build\`, then start a new run`);
}

/** After the install: metadata under the run's home names the run launcher, the launcher is hippo's wrapper, hooks.json holds hippo's two groups. */
function assertInstalled(run, where) {
  const launcher = run.codexLauncher;
  const metaFile = metaFileOf(run);
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const wrapped = same(meta.commandPath, launcher) && same(meta.originalCodexPath, launcher) && fs.existsSync(meta.realCodexPath ?? '') && fs.readFileSync(launcher, 'utf8').includes(WRAPPER_MARK);
  if (!wrapped) throw new Error(`${where}: hippo's install did not wrap the run launcher ${launcher} (${metaFile} names ${meta.commandPath ?? 'nothing'}); the run is abandoned`);
  const hooksFile = path.join(run.dirs.codexHome, 'hooks.json');
  const hooks = fs.existsSync(hooksFile) ? JSON.parse(fs.readFileSync(hooksFile, 'utf8')).hooks ?? {} : {};
  const missing = Object.keys(HOOK_MARKS).filter((event) => (hooks[event] ?? []).filter((g) => JSON.stringify(g).includes(HOOK_MARKS[event])).length !== 1);
  if (missing.length) throw new Error(`${where}: after hippo's install, ${hooksFile} does not hold one hippo group for ${missing.join(' and ')}; the run is abandoned`);
  assertWrapperRuns(launcher, where);
}

/** X2's install, once per run (plan D7): the probe, `hippo hook install codex` under the launcher guard, then the checks; any failure abandons the run. */
export function installHippoCodex(ctx, run, env = installEnv(run)) {
  const where = whereOf(run);
  assertInstallProbe(run, env);
  guardLaunchers(ctx, where, () => {
    const r = sh(`"${process.execPath}" "${HIPPO_JS}" hook install codex`, run.dirs.work, env, 5 * 60_000);
    if (r.status !== 0) throw new Error(`${where}: hippo hook install codex exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-500)}; the run is abandoned`);
  });
  assertInstalled(run, where);
}

/** `--check-homes` for X2: the same install on the check's fresh run, with a launcher onto the operator's real codex and no login. */
export function checkInstaller(codexBin = 'codex', baseEnv = process.env) {
  const ctx = { codexLauncher: resolveCodex(codexBin, baseEnv) };
  return (run) => {
    fs.mkdirSync(path.join(run.dirs.home, 'appdata'), { recursive: true });
    run.codexLauncher = writeLauncher(run.dirs.bin, ctx.codexLauncher.path);
    installHippoCodex(ctx, run);
  };
}
