/**
 * `hippo doctor`: a health check people and agents can run after installing
 * hippo, or when something seems off. Read-only: it never creates a store,
 * installs a hook or migrates a database. Every non-passing check names the
 * command that fixes it, so an agent can act on the `--json` output.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findHippoStoreDir } from './project-identity.js';
import { getGlobalRoot } from './shared.js';
import { isInitialized } from './store.js';
import { openHippoDbReadOnly, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion, countTableRows, IncompatibleBinaryError, type DatabaseSyncLike } from './db.js';
import { isEmbeddingAvailable } from './embeddings.js';
import type { JsonValue } from './working-memory.js';

/** Outcome of one check. `fail` makes `hippo doctor` exit 1. */
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'info';

/** One check in a {@link DoctorReport}. */
export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
  /** Command or step that resolves a warn or fail. */
  fix?: string;
}

/** Result of {@link runDoctor}. */
export interface DoctorReport {
  ok: boolean;
  version: string;
  /** The store the checks ran against, or null when none exists. */
  store: string | null;
  checks: DoctorCheck[];
}

/** Inputs for {@link runDoctor}; defaults come from the process. */
export interface DoctorOpts {
  cwd?: string;
  /** Home directory used to find agent configuration (~/.claude). */
  home?: string;
  version: string;
  nodeVersion?: string;
  now?: Date;
}

/** Minimum Node.js version hippo supports (package.json engines). */
export const MIN_NODE = '22.16.0';

function versionAtLeast(actual: string, min: string): boolean {
  const a = actual.replace(/^v/, '').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function readJson(file: string): JsonValue | null {
  try {
    // SAFETY: JSON.parse returns a JSON value by definition.
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    return null;
  }
}

// Migration 46 creates failure_log; a read-only open no longer creates it on an older store.
const FAILURE_LOG_SCHEMA = 46;

/** The failed-tool-call count over the last 7 days, or why it could not be read. */
function failuresCheck(db: DatabaseSyncLike, since: string, schemaVersion: number): DoctorCheck {
  try {
    // SAFETY: COUNT aggregate row.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM failure_log WHERE ts >= ?`).get(since) as { n: number } | undefined;
    return { id: 'failures', status: 'info', detail: `${Number(row?.n ?? 0)} failed tool calls logged in 7 days (hippo failures for detail)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('no such table')) {
      return { id: 'failures', status: 'warn', detail: `cannot read the failure log: ${message}` };
    }
    return schemaVersion < FAILURE_LOG_SCHEMA
      ? { id: 'failures', status: 'info', detail: 'no failure log yet (hippo creates it on the next write)' }
      : { id: 'failures', status: 'warn', detail: 'the failure_log table is missing, so failed tool calls are not being logged' };
  }
}

/** How long ago the store last slept (consolidated), or why that history could not be read. */
function sleepCheck(db: DatabaseSyncLike, now: Date): DoctorCheck {
  try {
    // SAFETY: row's shape matches the single `timestamp` column named in the SELECT above.
    const row = db.prepare(`SELECT timestamp FROM consolidation_runs ORDER BY timestamp DESC, id DESC LIMIT 1`).get() as { timestamp?: string } | undefined;
    const when = row?.timestamp !== undefined ? Date.parse(row.timestamp) : Number.NaN;
    if (Number.isNaN(when)) {
      return { id: 'sleep', status: 'warn', detail: 'hippo has never slept (consolidated) in this store', fix: 'hippo sleep   (the session-end hook runs it automatically)' };
    }
    const days = Math.floor((now.getTime() - when) / 86_400_000);
    return days > 7
      ? { id: 'sleep', status: 'warn', detail: `last sleep ${days} days ago`, fix: 'hippo sleep, and check the session-end hook is installed' }
      : { id: 'sleep', status: 'pass', detail: `last sleep ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id: 'sleep', status: 'info', detail: `sleep history unavailable (${message})` };
  }
}

/** Run every check. Never throws for a broken install; broken parts become failed checks. */
export function runDoctor(opts: DoctorOpts): DoctorReport {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? new Date();
  const checks: DoctorCheck[] = [];

  const node = opts.nodeVersion ?? process.versions.node;
  checks.push(versionAtLeast(node, MIN_NODE)
    ? { id: 'node', status: 'pass', detail: `Node.js ${node}` }
    : { id: 'node', status: 'fail', detail: `Node.js ${node} is older than ${MIN_NODE}`, fix: `Install Node.js ${MIN_NODE} or newer` });

  const local = findHippoStoreDir(cwd);
  const globalRoot = getGlobalRoot();
  const hasGlobal = isInitialized(globalRoot);
  let store: string | null = null;
  if (local !== null && isInitialized(local)) {
    store = local;
    checks.push({ id: 'store', status: 'pass', detail: `project store at ${local}${hasGlobal ? ` (global store at ${globalRoot} too)` : ''}` });
  } else if (local !== null) {
    // The walk stops at the first .hippo it finds, so a bare one (no hippo.db) blocks a parent or global store too.
    checks.push({ id: 'store', status: 'fail', detail: `${local} has no hippo.db, so hippo commands run here stop at it`, fix: `run hippo init in ${path.dirname(local)}, or remove that .hippo folder` });
  } else if (hasGlobal) {
    store = globalRoot;
    checks.push({ id: 'store', status: 'warn', detail: `no project store here; using the global store at ${globalRoot}`, fix: 'hippo init   (in the project root)' });
  } else {
    checks.push({ id: 'store', status: 'fail', detail: 'no hippo store found (project or global)', fix: 'hippo init   (in the project root), or hippo init --global' });
  }

  if (store !== null) {
    let db: DatabaseSyncLike | null = null;
    try {
      db = openHippoDbReadOnly(store);
      const have = getSchemaVersion(db);
      const want = getCurrentSchemaVersion();
      checks.push(have === want
        ? { id: 'schema', status: 'pass', detail: `database schema v${have}` }
        : have > want
          ? { id: 'schema', status: 'fail', detail: `database schema v${have} is newer than this hippo (v${want})`, fix: 'npm install -g hippo-memory@latest' }
          : { id: 'schema', status: 'info', detail: `database schema v${have}; hippo migrates it to v${want} on the next write` });
      const memories = countTableRows(db, 'memories');
      const dormant = countTableRows(db, 'dormant_memories');
      const memoryCheck: DoctorCheck = { id: 'memories', status: 'info', detail: `${memories ?? '?'} memories${dormant !== null ? `, ${dormant} dormant` : ''}` };
      if (memories === 0) {
        memoryCheck.status = 'warn';
        memoryCheck.fix = 'hippo learn --git   (seed lessons from git history)';
      }
      checks.push(memoryCheck);
      const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
      try {
        // SAFETY: COUNT/SUM aggregate row.
        const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(tokens), 0) AS t FROM token_ledger WHERE ts >= ? AND event = 'inject'`).get(since) as { n: number; t: number } | undefined;
        checks.push({ id: 'tokens', status: 'info', detail: `${Number(row?.n ?? 0)} memory blocks sent to agents in 7 days, about ${Number(row?.t ?? 0)} tokens (hippo tokens for detail)` });
      } catch {
        checks.push({ id: 'tokens', status: 'info', detail: 'no token ledger yet (created on the next write)' });
      }
      checks.push(failuresCheck(db, since, have));
      checks.push(sleepCheck(db, now));
    } catch (err) {
      checks.push({
        id: 'schema',
        status: 'fail',
        detail: `cannot open the database: ${err instanceof Error ? err.message : String(err)}`,
        fix: err instanceof IncompatibleBinaryError ? 'npm install -g hippo-memory@latest' : 'check file permissions on the .hippo folder',
      });
    } finally {
      if (db !== null) closeHippoDb(db);
    }
  }

  const claudeDir = path.join(home, '.claude');
  if (fs.existsSync(claudeDir)) {
    const settings = readJson(path.join(claudeDir, 'settings.json'));
    const text = settings === null ? '' : JSON.stringify(settings);
    const viaPlugin = /hippo-memory@/.test(text);
    // Each hook and what it does, so a partial install says what is missing.
    const hooks: Array<[string, string]> = [
      ['hippo context --pinned-only', 'per-prompt memory'],
      ['hippo session-end', 'session-end capture and sleep'],
      ['hippo pre-compact', 'compaction snapshot and capture'],
      ['hippo compact-resume', 'resume after compaction'],
      ['hippo post-compact', 'the message after compaction'],
      ['hippo capture-error', 'failed-tool capture'],
    ];
    const missing = hooks.filter(([marker]) => !text.includes(marker)).map(([, what]) => what);
    if (viaPlugin) {
      checks.push({ id: 'claude-code', status: 'pass', detail: 'Claude Code: hippo plugin enabled (all hooks, including compaction and failed-tool capture)' });
    } else if (missing.length === 0) {
      checks.push({ id: 'claude-code', status: 'pass', detail: 'Claude Code: all hippo hooks installed, including compaction and failed-tool capture' });
    } else if (missing.length === hooks.length) {
      checks.push({ id: 'claude-code', status: 'warn', detail: 'Claude Code found, but no hippo hooks are installed', fix: 'hippo hook install claude-code' });
    } else {
      checks.push({ id: 'claude-code', status: 'warn', detail: `Claude Code: hippo hooks missing for ${missing.join(', ')}`, fix: 'hippo hook install claude-code   (adds only what is missing)' });
    }
  } else {
    checks.push({ id: 'claude-code', status: 'info', detail: 'Claude Code not found; other agents can use hippo over MCP (hippo mcp)' });
  }

  checks.push({ id: 'embeddings', status: 'info', detail: isEmbeddingAvailable() ? 'local embeddings available (hybrid search)' : 'embeddings not installed; recall uses BM25 (optional: hippo embed --help)' });

  return { ok: !checks.some((c) => c.status === 'fail'), version: opts.version, store, checks };
}

/** Human-readable rendering of a {@link DoctorReport}. */
export function formatDoctor(report: DoctorReport): string {
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' } satisfies Record<DoctorStatus, string>;
  const lines = [`hippo ${report.version} doctor`, ''];
  for (const c of report.checks) {
    lines.push(`  [${mark[c.status]}] ${c.id.padEnd(11)} ${c.detail}`);
    if (c.fix && (c.status === 'warn' || c.status === 'fail')) lines.push(`         ${''.padEnd(11)} fix: ${c.fix}`);
  }
  lines.push('', report.ok ? 'No failures.' : 'Some checks failed; run the fix commands above.');
  return lines.join('\n');
}
