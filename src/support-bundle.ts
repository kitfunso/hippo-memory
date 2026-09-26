/** `hippo support-bundle`: one redacted JSON snapshot for a support ticket. Read-only; never touches memory content. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

// Longest first: where one home form nests in another (a test home under the real one), swap the longer.
function collectHomeForms(home: string, probes: readonly string[]): string[] {
  const forms = new Set<string>();
  const add = (s: string): void => { if (s.length >= 3) forms.add(s); };
  for (const base of [home, realpathOrResolve(home), os.homedir(), realpathOrResolve(os.homedir())]) {
    add(base);
    add(path.resolve(base));
    if (process.platform === 'win32') {
      add(base.replace(/\\/g, '/'));
      add(path.resolve(base).replace(/\\/g, '/'));
    }
  }

  // The alias (e.g. a short-name temp root) can sit above the probe itself, so walk ancestors and
  // compare native realpaths rather than checking each probe alone.
  const homeKeys = new Set([nativeRealPathKey(home), nativeRealPathKey(os.homedir())].filter((k): k is string => k !== null));
  for (const probe of probes) {
    let dir = path.resolve(probe);
    for (;;) {
      const key = nativeRealPathKey(dir);
      if (key !== null && homeKeys.has(key)) {
        add(dir);
        if (process.platform === 'win32') add(dir.replace(/\\/g, '/'));
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const f of [...forms].sort((a, b) => b.length - a.length)) {
    const key = process.platform === 'win32' ? f.toLowerCase() : f;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  return deduped;
}

function replaceHomeForms(text: string, forms: readonly string[]): string {
  if (forms.length === 0) return text;
  // Stop only before another name character: "<home> now" and "<home>." swap, a longer user name ("<home>ty") does not.
  const re = new RegExp(`(?:${forms.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, process.platform === 'win32' ? 'giu' : 'gu');
  return text.replace(re, '~');
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

function redactString(text: string, homeForms: readonly string[]): string {
  return replaceHomeForms(redactSecretsStrict(redactUrlsInString(text)), homeForms);
}

function redactStrings(value: JsonValue, homeForms: readonly string[]): JsonValue {
  if (isJsonString(value)) return redactString(value, homeForms);
  if (Array.isArray(value)) return value.map((v) => redactStrings(v, homeForms));
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactStrings(v, homeForms);
    return out;
  }
  return value;
}

/** Read-only: builds one redacted support-ticket snapshot. Never reads a memory content column. */
export function buildSupportBundle(opts: SupportBundleOpts): JsonObject {
  const bundle: JsonObject = {
    format: 'hippo-support-bundle/1',
    createdAt: opts.now.toISOString(),
    hippo: opts.version,
    runtime: buildRuntime(),
    doctor: JSON.parse(JSON.stringify(runDoctor(opts))),
    stores: buildStores(opts),
    env: listSetEnvNames(),
    logs: buildLogsSection(opts),
  };
  // Store paths found from the working folder arrive resolved; the global root arrives as HIPPO_HOME was typed, and log lines
  // often quote the temp folder, which usually sits under the home.
  const redacted = redactStrings(bundle, collectHomeForms(opts.home, [getGlobalRoot(), os.tmpdir()]));
  // SAFETY: the value built above is always a JsonObject; redactStrings preserves object shape.
  return redacted as JsonObject;
}
