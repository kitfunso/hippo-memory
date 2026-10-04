// A checkout's `origin` remote, read from its git config file and normalised into a project id; no git process, so the prompt hook can call it.
import * as fs from 'fs';
import * as path from 'path';
import { isObjectLike, isStringValue } from './capture-contract.js';
import { log } from './log.js';

/** The config file git reads for a checkout: `.git/config`, a linked worktree's `<commondir>/config`, a submodule's `<gitdir>/config`. */
export function gitConfigPath(gitRoot: string): string | null {
  const marker = path.join(gitRoot, '.git');
  try {
    if (fs.statSync(marker).isDirectory()) return path.join(marker, 'config');
    const gitDir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(marker, 'utf8'))?.[1]?.trim();
    if (!gitDir) return null;
    const linkDir = path.resolve(gitRoot, gitDir);
    const commondir = path.join(linkDir, 'commondir');
    if (!fs.existsSync(commondir)) return path.join(linkDir, 'config');
    return path.join(path.resolve(linkDir, fs.readFileSync(commondir, 'utf8').trim()), 'config');
  } catch (err) {
    log.debug(`project remote: no git config for ${gitRoot}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** One config value with git's quoting: `"` toggles quoting, backslash escapes, and an unquoted `#` or `;` starts a comment. */
function configValue(raw: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'b' ? '' : next;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (!quoted && (c === '#' || c === ';')) {
      break;
    } else {
      out += c;
    }
  }
  return out.trim();
}

const SECTION = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/;
const ENTRY = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;

/** `remote.origin.url` from a config file's text, the first value as git fetch uses; the subsection name is case-sensitive. */
export function originUrlFromConfig(text: string): string | null {
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const section = SECTION.exec(line);
    if (section) {
      const [, name, sub, rest] = section;
      inOrigin = sub === undefined
        ? name.toLowerCase() === 'remote.origin'
        : name.toLowerCase() === 'remote' && sub.replace(/\\(.)/g, '$1') === 'origin';
      line = rest.trim();
    }
    const entry = inOrigin ? ENTRY.exec(line) : null;
    if (entry && entry[1].toLowerCase() === 'url' && entry[2] !== undefined) {
      const value = configValue(entry[2]);
      if (value !== '') return value;
    }
  }
  return null;
}

/** Azure DevOps names one repo three ways; all become `dev.azure.com/org/project/repo`. */
function azureDevOps(hostPath: string): string {
  const ssh = /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/(.+)$/.exec(hostPath);
  if (ssh) return `dev.azure.com/${ssh[1]}`;
  const legacy = /^([^/.]+)\.visualstudio\.com\/(?:defaultcollection\/)?(.+)$/.exec(hostPath);
  const https = legacy ? `dev.azure.com/${legacy[1]}/${legacy[2]}` : hostPath;
  return https.startsWith('dev.azure.com/') ? https.replace('/_git/', '/') : https;
}

/** `host/path` for a network remote, so ssh, scp and https forms agree; null for a local path, which would put a user path into rows. */
export function normaliseRemote(url: string): string | null {
  const u = url.trim();
  if (u === '' || u.includes('::') || /^file:/i.test(u) || /^[A-Za-z]:[\\/]/.test(u) || /^[./\\~]/.test(u)) return null;
  let hostPath: string;
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)(.*)$/.exec(u);
  if (withScheme) {
    // Userinfo can hold a token, and a port differs between ssh and https.
    hostPath = withScheme[1].replace(/^.*@/, '').replace(/:\d*$/, '') + withScheme[2];
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(u);
    if (!scp) return null;
    hostPath = `${scp[1]}/${scp[2]}`;
  }
  const tidy = hostPath.toLowerCase().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const id = azureDevOps(tidy);
  // A colon would break the `shared:<project>:` source format; whitespace means this was no URL.
  return /^[^/]+\/./.test(id) && !/[:\s]/.test(id) ? id : null;
}

/** The normalised origin of the checkout rooted at gitRoot, or null when it has none a project can be named by. */
export function originRemoteId(gitRoot: string): string | null {
  const file = gitConfigPath(gitRoot);
  if (file === null) return null;
  try {
    const url = originUrlFromConfig(fs.readFileSync(file, 'utf8'));
    return url === null ? null : normaliseRemote(url);
  } catch (err) {
    log.debug(`project remote: ${file} not read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export const PROJECT_FILE = '.hippo-project.json';

/** The `id` a team committed in `.hippo-project.json` at root, lowercased like every project name; null when absent or unusable. */
export function projectFileId(root: string): string | null {
  const file = path.join(root, PROJECT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = isObjectLike(parsed) && 'id' in parsed ? parsed.id : undefined;
    const id = isStringValue(raw) ? raw.trim().toLowerCase() : '';
    if (id !== '' && id.length <= 200 && !/[:\s]/.test(id)) return id;
    log.warn(`${file}: "id" must be a non-empty string with no colon or spaces; using the remote or folder name instead`);
  } catch (err) {
    log.warn(`${file} not read: ${err instanceof Error ? err.message : String(err)}; using the remote or folder name instead`);
  }
  return null;
}
