/** `hippo support-bundle`: one redacted JSON snapshot for a support ticket. Read-only (SQLite may leave empty -wal and -shm files); never touches memory content. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { findHippoStoreDir, isGlobalStoreRoot, realpathOrResolve } from './project-identity.js';
import { getGlobalRoot } from './shared.js';
import { isInitialized } from './store.js';
import { openHippoDbReadOnly, closeHippoDb, getSchemaVersion, getMeta, countTableRows, type DatabaseSyncLike } from './db.js';
import { runDoctor, type DoctorOpts } from './doctor.js';
import { loadConfig } from './config.js';
import { redactSecretsStrict } from './secret-detect.js';
import type { JsonValue, JsonObject } from './working-memory.js';

export interface SupportBundleOpts extends DoctorOpts {
  readonly cwd: string;
  readonly home: string;
  readonly now: Date;
  readonly includeLogs: boolean;
}

const TAIL_MAX_BYTES = 256 * 1024;
export const TAIL_MAX_LINES = 200;
const TAIL_MAX_LINE_CHARS = 2000;
// Greedy on purpose: complete key blocks are redacted first, so any END left is an orphan and what precedes it may be key body.
const ORPHAN_KEY_END_RE = /^[\s\S]*-----END [A-Z ]*PRIVATE KEY-----/;

// The other env vars hippo reads outside the HIPPO_ prefix (src/embedding-provider.ts, connectors/*).
const OTHER_ENV_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'COHERE_API_KEY', 'TYPESAFE_API_KEY',
  'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET_PREVIOUS',
  'GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID',
  'SLACK_SIGNING_SECRET', 'SLACK_SIGNING_SECRET_PREVIOUS', 'SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK',
  'XDG_DATA_HOME', 'MCP_SSE_HEARTBEAT_MS', 'MCP_SSE_MAX_AGE_SEC',
];

const CONFIG_SECRET_KEY_RE = /key|token|secret|passw|credential|auth|cookie|bearer|signature|private/i;

function isJsonObject(v: JsonValue): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJsonString(v: JsonValue): v is string {
  return typeof v === 'string';
}

function buildRuntime(): JsonObject {
  return {
    node: process.versions.node,
    sqlite: process.versions.sqlite ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  };
}

function listTableNames(db: DatabaseSyncLike): string[] {
  // SAFETY: each row's shape matches the single `name` column named in the SELECT above.
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name`,
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function countTables(db: DatabaseSyncLike): JsonObject {
  const tables: JsonObject = {};
  for (const name of listTableNames(db)) tables[name] = countTableRows(db, name);
  return tables;
}

function redactConfigValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactConfigValue);
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = CONFIG_SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactConfigValue(v);
    }
    return out;
  }
  return value;
}

interface StoreConfigReport {
  readonly configFile: 'absent' | 'present' | 'invalid';
  readonly config: JsonValue;
}

function readStoreConfig(storeDir: string): StoreConfigReport {
  const configPath = path.join(storeDir, 'config.json');
  let configFile: 'absent' | 'present' | 'invalid' = 'absent';
  if (fs.existsSync(configPath)) {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf8'));
      configFile = 'present';
    } catch {
      configFile = 'invalid';
    }
  }
  // loadConfig always returns the effective config: its own defaults on a missing or broken file.
  const effective: JsonValue = JSON.parse(JSON.stringify(loadConfig(storeDir)));
  return { configFile, config: redactConfigValue(effective) };
}

function buildStoreEntry(kind: 'project' | 'global', storeDir: string): JsonObject {
  const dbPath = path.join(storeDir, 'hippo.db');
  if (!fs.existsSync(dbPath)) {
    return { kind, path: storeDir, error: 'no hippo.db here (hippo init has not run)' };
  }
  // Stat before opening: a read-only open leaves an empty -wal behind it.
  const files: JsonObject = { 'hippo.db': fs.statSync(dbPath).size };
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath)) files['hippo.db-wal'] = fs.statSync(walPath).size;

  let db: DatabaseSyncLike | null = null;
  try {
    db = openHippoDbReadOnly(storeDir);
    const schemaVersion = getSchemaVersion(db);
    const minCompatibleBinary = getMeta(db, 'min_compatible_binary', '') || null;
    const tables = countTables(db);
    const { configFile, config } = readStoreConfig(storeDir);
    return { kind, path: storeDir, schemaVersion, minCompatibleBinary, files, tables, configFile, config };
  } catch (err) {
    return { kind, path: storeDir, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (db !== null) closeHippoDb(db);
  }
}

function buildStores(opts: SupportBundleOpts): JsonValue[] {
  const stores: JsonValue[] = [];
  const projectDir = findHippoStoreDir(opts.cwd, { homeDir: opts.home });
  if (projectDir !== null) stores.push(buildStoreEntry('project', projectDir));

  const globalDir = getGlobalRoot();
  const alreadyListed = projectDir !== null && isGlobalStoreRoot(projectDir);
  if (isInitialized(globalDir) && !alreadyListed) stores.push(buildStoreEntry('global', globalDir));

  return stores;
}

function listSetEnvNames(): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('HIPPO_')) names.add(key);
  }
  for (const key of OTHER_ENV_NAMES) {
    if (process.env[key] !== undefined) names.add(key);
  }
  return [...names].sort();
}

function listLogFileNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();
}

function tailLogFile(file: string): string[] {
  const size = fs.statSync(file).size;
  const readSize = Math.min(size, TAIL_MAX_BYTES);
  const startedMidFile = size > TAIL_MAX_BYTES;
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  let lines = text.split(/\r?\n/);
  // A tail read starting mid-file cuts its first piece off mid-line.
  if (startedMidFile) lines = lines.slice(1);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  // Redact before splitting: a private key spans lines. An END still left has lost its BEGIN to the window cut.
  const redacted = redactSecretsStrict(lines.join('\n')).replace(ORPHAN_KEY_END_RE, '[REDACTED]');
  return redacted.split('\n').slice(-TAIL_MAX_LINES).map((line) =>
    line.length > TAIL_MAX_LINE_CHARS ? `${line.slice(0, TAIL_MAX_LINE_CHARS)} [truncated]` : line,
  );
}

function buildLogsSection(opts: SupportBundleOpts): JsonObject {
  const dir = path.join(opts.home, '.hippo', 'logs');
  const names = listLogFileNames(dir);
  const files: JsonObject[] = names.map((name) => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
  });
  const logs: JsonObject = { dir: '~/.hippo/logs', files };
  if (opts.includeLogs) {
    const tails: JsonObject = {};
    for (const name of names) tails[name] = tailLogFile(path.join(dir, name));
    logs['tails'] = tails;
  }
  return logs;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The native realpath is the only form that exposes a short-name (8.3) or symlinked alias for what it is.
function nativeRealPathKey(p: string): string | null {
  try {
    const real = fs.realpathSync.native(p);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    // A path that does not exist has no alias to find.
    return null;
  }
}

function collectHomeAliases(home: string, probes: readonly string[]): Set<string> {
  const aliases = new Set<string>();
  for (const base of [home, realpathOrResolve(home), os.homedir(), realpathOrResolve(os.homedir())]) {
    aliases.add(base);
    aliases.add(path.resolve(base));
  }

  // The alias (e.g. a short-name temp root) can sit above the probe itself, so walk ancestors and
  // compare native realpaths rather than checking each probe alone.
  const homeKeys = new Set([nativeRealPathKey(home), nativeRealPathKey(os.homedir())].filter((k): k is string => k !== null));
  for (const probe of probes) {
    let dir = path.resolve(probe);
    for (;;) {
      const key = nativeRealPathKey(dir);
      if (key !== null && homeKeys.has(key)) aliases.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return aliases;
}

// Node's own encoding, so it matches file URLs and ESM stack frames; a drive path's URL gains a leading slash.
function fileUrlPath(p: string): string {
  const pathname = pathToFileURL(p).pathname;
  return /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
}

// A home turns up as a path, as a file URL's percent-encoded path, and as a Claude Code project folder name.
const HOME_SPELLINGS: readonly ((p: string) => string)[] = [
  (p) => p,
  fileUrlPath,
  (p) => p.replace(/[^A-Za-z0-9]/g, '-'),
];

// Git Bash, Cygwin and WSL mount a drive at /c, /cygdrive/c and /mnt/c; a Claude Code folder name writes each / and : as -.
function mountedDrive(letter: string): string {
  return `(?:${letter}[:-]|(?:[-/](?:cygdrive|mnt))?[-/]${letter})`;
}

/** Regex source for one spelling of the home, or null when too little of it is left to swap safely. */
function spellingPattern(spelling: string, deep: boolean): string | null {
  if (process.platform !== 'win32') return spelling.length >= 3 ? escapeRegExp(spelling) : null;
  // Each tool that mounts a drive writes it its own way, so a home two or more folders below its drive (\Users\<name>)
  // matches after any prefix, with \, / or JSON's \\ between folders. A drive written a known way goes into the swap with it.
  const drive = /^([A-Za-z])[:-]/.exec(spelling);
  const below = drive === null ? spelling : spelling.slice(2);
  const body = below.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]+');
  if (drive === null) {
    if (spelling.length < 3) return null;
    return deep ? body : `(?<![\\p{L}\\p{N}_])${body}`;
  }
  if (deep) return `${mountedDrive(drive[1])}?${body}`;
  // One folder (C:\x, D:\home) is a name any path may hold, so it swaps only after its drive and as a whole name; a drive
  // root swaps nothing.
  return /[^\\/-]/.test(below) ? `(?<![\\p{L}\\p{N}_])${mountedDrive(drive[1])}${body}` : null;
}

/** One pattern for every alias of the home in every spelling, or null when none is long enough to swap safely. */
function buildHomePattern(home: string, probes: readonly string[]): RegExp | null {
  const spellings: [spelling: string, deep: boolean][] = [];
  for (const alias of collectHomeAliases(home, probes)) {
    // Counted on the path, since its folder-name spelling cannot tell C:\a-b from C:\a\b.
    const deep = alias.replace(/^[A-Za-z]:/, '').split(/[\\/]+/).filter(Boolean).length >= 2;
    for (const spell of HOME_SPELLINGS) spellings.push([spell(alias), deep]);
  }
  // Longest first: where one home nests in another (a test home under the real one), swap the longer.
  const patterns = new Map<string, string>();
  for (const [s, deep] of spellings.sort(([a], [b]) => b.length - a.length)) {
    const pattern = spellingPattern(s, deep);
    if (pattern === null) continue;
    const key = process.platform === 'win32' ? pattern.toLowerCase() : pattern;
    if (!patterns.has(key)) patterns.set(key, pattern);
  }
  if (patterns.size === 0) return null;
  // Whole names only: "<home> now" and "<home>." swap; "<home>ty", or "web-app" for a home of /app, do not. On Windows
  // the start is spellingPattern's call, because the path below the drive may follow anything.
  const before = process.platform === 'win32' ? '' : '(?<![\\p{L}\\p{N}_])';
  const alternatives = [...patterns.values()].join('|');
  return new RegExp(`${before}(?:${alternatives})(?![\\p{L}\\p{N}_])`, process.platform === 'win32' ? 'giu' : 'gu');
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function redactUrlsInString(text: string): string {
  return text.replace(URL_RE, (match) => {
    const scheme = match.slice(0, match.indexOf('://'));
    try {
      const url = new URL(match);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return `${scheme}://[REDACTED]`;
    }
  });
}

function redactString(text: string, homePattern: RegExp | null): string {
  const scrubbed = redactSecretsStrict(redactUrlsInString(text));
  return homePattern === null ? scrubbed : scrubbed.replace(homePattern, '~');
}

function redactStrings(value: JsonValue, homePattern: RegExp | null): JsonValue {
  if (isJsonString(value)) return redactString(value, homePattern);
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, homePattern));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactStrings(v, homePattern);
    return out;
  }
  return value;
}

/** Read-only: builds one redacted support-ticket snapshot. Never reads a memory content column. */
export function buildSupportBundle(opts: SupportBundleOpts): JsonObject {
  // Before doctor: its read-only open leaves an empty -wal that the store's file list would then report.
  const stores = buildStores(opts);
  const bundle: JsonObject = {
    format: 'hippo-support-bundle/1',
    createdAt: opts.now.toISOString(),
    hippo: opts.version,
    runtime: buildRuntime(),
    doctor: JSON.parse(JSON.stringify(runDoctor(opts))),
    stores,
    env: listSetEnvNames(),
    logs: buildLogsSection(opts),
  };
  // Store paths found from the working folder arrive resolved; the global root arrives as HIPPO_HOME was typed, and log lines
  // often quote the temp folder, which usually sits under the home.
  const redacted = redactStrings(bundle, buildHomePattern(opts.home, [getGlobalRoot(), os.tmpdir()]));
  // SAFETY: the value built above is always a JsonObject; redactStrings preserves object shape.
  return redacted as JsonObject;
}
