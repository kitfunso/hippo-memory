// The Codex login as a secret (E6 plan D3, R4, R6, R24): one vault copy outside the out dir, a run copy only while a session runs.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Codex's own files that hold the token on a clean session; smoke fills it (plan R24), so until then any token hit abandons the run. */
export const CODEX_TOKEN_FILES = [];
export const CODEX_AUTH_RE = /401 Unauthorized|refresh token|log in again|not logged in|invalid_grant|token (?:has )?expired/i;
const SECRET_KEY = /token|secret|api_key/i;
const AUTH_FILE = 'auth.json';

/** String leaves under a secret-named key, 8 chars or longer, so a short flag value never turns into a redaction. */
function secretLeaves(value, underSecret = false) {
  if (Array.isArray(value)) return value.flatMap((v) => secretLeaves(v, underSecret));
  if (value !== null && value !== undefined && value.constructor === Object) return Object.entries(value).flatMap(([k, v]) => secretLeaves(v, underSecret || SECRET_KEY.test(k)));
  return underSecret && value !== null && value !== undefined && value.constructor === String && value.length >= 8 ? [value] : [];
}

/** The token strings in an auth file; a file that is not JSON holds none the runner can name. */
function fileTokens(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return secretLeaves(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // A half-written refresh is caught by the next authOut, which reads the file again.
    return [];
  }
}

/** The operator's login file: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function defaultAuthFile(env) {
  if (env.CODEX_HOME) return path.join(env.CODEX_HOME, AUTH_FILE);
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex', AUTH_FILE);
}

/** One copy of the operator's login in the user's temp dir; the operator's file is read here once and never written. */
export function openAuthVault(src) {
  if (!fs.existsSync(src)) throw new Error(`no Codex login at ${src}; run \`codex login\` or pass --codex-auth <auth.json>`);
  const tokens = fileTokens(src);
  if (tokens.length === 0) throw new Error(`${src} holds no token; run \`codex login\` again`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-codex-auth-'));
  const file = path.join(dir, AUTH_FILE);
  fs.copyFileSync(src, file);
  return { dir, file, seen: new Set(tokens) };
}

/** Put the vault login into a run's Codex home just before its session. */
export function authIn(vault, codexHome) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.copyFileSync(vault.file, path.join(codexHome, AUTH_FILE));
}

/** After a session: remember the run copy's tokens, keep a refreshed login in the vault, then delete every auth file in the home. */
export function authOut(vault, codexHome) {
  const runFile = path.join(codexHome, AUTH_FILE);
  const tokens = fileTokens(runFile);
  for (const tok of tokens) vault.seen.add(tok);
  // A refresh rotates the refresh token, so the next session needs the new file; a copy with no token is a broken write, never kept.
  if (tokens.length > 0 && !fs.readFileSync(runFile).equals(fs.readFileSync(vault.file))) fs.copyFileSync(runFile, vault.file);
  if (!fs.existsSync(codexHome)) return;
  for (const name of fs.readdirSync(codexHome)) if (name.startsWith(AUTH_FILE)) fs.rmSync(path.join(codexHome, name), { force: true });
}

/** Every token the runner has seen, the run copy's current ones included, longest first so a token inside another is never left half. */
function knownTokens(vault, codexHome) {
  const all = new Set([...vault.seen, ...fileTokens(vault.file), ...(codexHome ? fileTokens(path.join(codexHome, AUTH_FILE)) : [])]);
  return [...all].sort((a, b) => b.length - a.length);
}

/** Text the runner is about to write, with every known token replaced by `[auth]`. */
export function redact(vault, codexHome, text) {
  let out = String(text ?? '');
  for (const tok of knownTokens(vault, codexHome)) out = out.split(tok).join('[auth]');
  return out;
}

/** `read()`, or null when its path is gone; any error but ENOENT still throws. */
function unlessGone(read) {
  try {
    return read();
  } catch (err) {
    // A hippo worker may still be closing its store under the sweep, and a file that no longer exists holds no token.
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

/** A file's bytes, or null when the file is gone. */
export const readIfPresent = (file) => unlessGone(() => fs.readFileSync(file));

/** An error as a short note: its code, else its message; never file bytes. */
export const errNote = (err) => err.code ?? err.message;

function* walk(dir, fail) {
  let entries;
  try {
    entries = unlessGone(() => fs.readdirSync(dir, { withFileTypes: true })) ?? [];
  } catch (err) {
    fail(dir, `unreadable: ${errNote(err)}`);
    return;
  }
  for (const e of entries) {
    const p = path.join(e.parentPath ?? dir, e.name);
    if (e.isDirectory()) yield* walk(p, fail);
    else if (e.isFile()) yield p;
  }
}

/** Every file under `roots` that holds a known token, deleted; returns their paths relative to `outDir` (a path the sweep could not read or delete carries a note), never the token. */
export function tokenSweep(vault, roots, outDir) {
  const tokens = knownTokens(vault, null).map((t) => Buffer.from(t, 'utf8'));
  const hits = [];
  // A per-path error is recorded and the walk goes on, so one locked file never hides a later token (plan R24).
  const fail = (p, note) => hits.push(`${path.relative(outDir, p).split(path.sep).join('/')} (${note})`);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const files = fs.statSync(root).isDirectory() ? [...walk(root, fail)] : [root];
    for (const f of files) {
      let bytes;
      try {
        bytes = readIfPresent(f);
      } catch (err) {
        fail(f, `unreadable: ${errNote(err)}`);
        continue;
      }
      if (bytes === null || !tokens.some((t) => bytes.includes(t))) continue;
      try {
        fs.rmSync(f, { force: true });
        hits.push(path.relative(outDir, f).split(path.sep).join('/'));
      } catch (err) {
        fail(f, `holds a token, not deleted: ${errNote(err)}`);
      }
    }
  }
  return [...new Set(hits)].sort();
}

const globRe = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** Delete Codex's own token-holding files (top-level names; `dir/` removes a dir) after a session's wait and before the sweep. */
export function removeTokenFiles(codexHome, patterns) {
  if (!fs.existsSync(codexHome)) return;
  for (const pattern of patterns) {
    const isDir = pattern.endsWith('/');
    const re = globRe(isDir ? pattern.slice(0, -1) : pattern);
    for (const e of fs.readdirSync(codexHome, { withFileTypes: true })) {
      if (re.test(e.name) && e.isDirectory() === isDir) fs.rmSync(path.join(codexHome, e.name), { recursive: true, force: true });
    }
  }
}

/** Remove the vault; a later read of its tokens is impossible by design. */
export function closeVault(vault) {
  if (vault) fs.rmSync(vault.dir, { recursive: true, force: true, maxRetries: 3 });
}
