/**
 * `hippo doctor`: a health check people and agents can run after installing
 * hippo, or when something seems off. Read-only: it never creates a store,
 * installs a hook or migrates a database. Every non-passing check names the
 * command that fixes it, so an agent can act on the `--json` output.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findHippoStoreDir } from './core/project-identity.js';
import { getGlobalRoot } from './sharing/shared.js';
import { isInitialized } from './store/open.js';
import { readStoreHealth, type StoreHealth } from './store/diagnostics.js';
import { loadConfig } from './core/config.js';
import { openHippoDbReadOnly, closeHippoDb, getCurrentSchemaVersion, IncompatibleBinaryError, type DatabaseSyncLike } from './db/index.js';
import { REPLAY_AFTER_MS, TRANSCRIPT_FILL_WINDOW_MS } from './capture/compaction-record.js';
import { SPOOL_DIR, spoolCounts, type SpoolCounts } from './capture/compaction-spool.js';
import { isEmbeddingAvailable } from './store/embeddings/local.js';
import { CODEX_TRUST_LINE, claudeConfigDir, codexHomeDir, isCodexPresent } from './hooks/shared.js';
import { planProjectRepair } from './sharing/project-merge.js';
import { resolveTenantId } from './store/tenant.js';
import { errorMessage, log } from './util/log.js';
import { readJsonFile, type JsonValue, isJsonObjectLiteral } from './util/json.js';
import { DAY_MS } from './util/time.js';

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
  /** Home directory used to find agent configuration (~/.claude unless CLAUDE_CONFIG_DIR is set, ~/.codex unless CODEX_HOME is). */
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
    return readJsonFile(file);
  } catch {
    // A missing or corrupt file is the finding doctor reports, so null is the answer.
    return null;
  }
}

// Trust lives in Codex's own config.toml rows; doctor reads only the hooks file and reminds.
function codexCheck(home: string): DoctorCheck {
  const file = path.join(codexHomeDir(home), 'hooks.json');
  const parsed = readJson(file);
  // Codex drops every hook in a hooks.json it cannot parse, hippo's included.
  if (fs.existsSync(file) && !isJsonObjectLiteral(parsed)) {
    return { id: 'codex', status: 'warn', detail: "Codex's hooks.json is not a JSON object, so Codex runs no hook from it", fix: 'repair hooks.json, then run: hippo hook install codex' };
  }
  const text = JSON.stringify(parsed ?? '');
  const codexHooks: Array<[string, string]> = [
    ['hippo context --pinned-only', 'per-prompt memory'],
    ['hippo compact-resume', 'resume after compaction'],
  ];
  const missing = codexHooks.filter(([marker]) => !text.includes(marker)).map(([, what]) => what);
  if (missing.length === 0) return { id: 'codex', status: 'pass', detail: `Codex: hippo memory hooks installed. ${CODEX_TRUST_LINE}` };
  return {
    id: 'codex',
    status: 'warn',
    detail: missing.length === codexHooks.length ? "Codex found, but hippo's memory hooks are not installed" : `Codex: hippo hooks missing for ${missing.join(', ')}`,
    fix: 'hippo hook install codex   (then trust the hooks once in /hooks)',
  };
}

// Migration 46 creates failure_log; a read-only open no longer creates it on an older store.
const FAILURE_LOG_SCHEMA = 46;

/** The failed-tool-call count over the last 7 days, or why it could not be read. */
function failuresCheck(failures: StoreHealth['failures'], schemaVersion: number): DoctorCheck {
  if (failures.ok) {
    return { id: 'failures', status: 'info', detail: `${failures.value} failed tool calls logged in 7 days (hippo failures for detail)` };
  }
  if (!failures.message.includes('no such table')) {
    return { id: 'failures', status: 'warn', detail: `cannot read the failure log: ${failures.message}` };
  }
  return schemaVersion < FAILURE_LOG_SCHEMA
    ? { id: 'failures', status: 'info', detail: 'no failure log yet (hippo creates it on the next write)' }
    : { id: 'failures', status: 'warn', detail: 'the failure_log table is missing, so failed tool calls are not being logged' };
}

/** How long ago the store last slept (consolidated), or why that history could not be read. */
function sleepCheck(lastSleep: StoreHealth['lastSleep'], now: Date): DoctorCheck {
  if (!lastSleep.ok) return { id: 'sleep', status: 'info', detail: `sleep history unavailable (${lastSleep.message})` };
  const last = lastSleep.value;
  const when = last !== undefined ? Date.parse(last) : Number.NaN;
  if (Number.isNaN(when)) {
    return { id: 'sleep', status: 'warn', detail: 'hippo has never slept (consolidated) in this store', fix: 'hippo sleep   (the session-end hook runs it automatically)' };
  }
  const days = Math.floor((now.getTime() - when) / DAY_MS);
  return days > 7
    ? { id: 'sleep', status: 'warn', detail: `last sleep ${days} days ago`, fix: 'hippo sleep, and check the session-end hook is installed' }
    : { id: 'sleep', status: 'pass', detail: `last sleep ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}` };
}

interface SpoolRead {
  counts: SpoolCounts;
  /** The detail's `; spool not read: <msg>` tail, empty when the spool was read. */
  unread: string;
}

/** Spool counts in their own try, so a spool that cannot be read never hides the database counts. */
function readSpool(store: string, now: Date): SpoolRead {
  try {
    return { counts: spoolCounts(store, now, REPLAY_AFTER_MS), unread: '' };
  } catch (err) {
    return { counts: { waiting: 0, stale: 0, bad: 0 }, unread: `; spool not read: ${errorMessage(err)}` };
  }
}

/** Compaction records the PostCompact hook left unfinished and spool files a replay has not finished, which `hippo sleep` replays. */
function compactionsCheck(compactions: StoreHealth['compactions'], store: string, now: Date): DoctorCheck {
  if (!compactions.ok) {
    return compactions.message.includes('no such table')
      ? { id: 'compactions', status: 'info', detail: 'no compaction records yet (hippo creates them on the next write)' }
      : { id: 'compactions', status: 'warn', detail: `cannot read the compaction records: ${compactions.message}` };
  }
  const { total, summarised, started } = compactions.value;
  const stuck = summarised + started;
  const { counts: spool, unread } = readSpool(store, now);
  const spooled = spool.waiting + spool.stale + spool.bad > 0;
  const recorded = `${total} compaction${total === 1 ? '' : 's'} recorded, none stuck`;
  if (stuck === 0 && !spooled && unread === '') return { id: 'compactions', status: 'pass', detail: recorded };
  const fix = [
    stuck + spool.waiting + spool.stale > 0 ? 'hippo sleep   (replays them)' : '',
    spool.bad > 0 ? `open the .bad files in ${path.join(store, SPOOL_DIR)}, save what you still need with hippo remember, then delete them` : '',
  ].filter((s) => s !== '');
  const unfinished = stuck === 0
    ? `${recorded} in the store`
    : `${stuck} compaction${stuck === 1 ? '' : 's'} unfinished after 10 minutes (${summarised} with a summary whose memories are not saved yet, ${started} with no summary yet)`;
  const note = spooled ? `; spool: ${spool.waiting} waiting, ${spool.stale} left by a replay that stopped, ${spool.bad} .bad` : '';
  return { id: 'compactions', status: 'warn', detail: `${unfinished}${note}${unread}`, fix: fix.join('; ') };
}

/** Old project tags in the global store, counted by the repair's own plan so a truly user-global merge never warns. */
function projectsCheck(globalRoot: string): DoctorCheck {
  let db: DatabaseSyncLike | null = null;
  try {
    db = openHippoDbReadOnly(globalRoot);
    const r = planProjectRepair(db, globalRoot, resolveTenantId({}));
    const found = [
      r.copies.length > 0 ? `${r.copies.length} imported notes copied under the wrong project` : '',
      r.folds.length > 0 ? `old project names that now resolve to another project: ${r.folds.map((f) => `${f.from} -> ${f.into}`).join(', ')}` : '',
      r.collisions.length > 0 ? `old project names shared by several projects, folded by hand only: ${r.collisions.map((c) => `${c.name} (${c.ids.join(', ')})`).join('; ')}` : '',
      r.toProject.length + r.setAside.length > 0 ? `${r.toProject.length + r.setAside.length} merged memories tagged user-global` : '',
    ].filter((s) => s !== '');
    return found.length === 0
      ? { id: 'projects', status: 'pass', detail: 'no duplicate or out-of-date project tags in the global store' }
      : { id: 'projects', status: 'warn', detail: `global store: ${found.join('; ')}`, fix: 'hippo projects repair --global   (dry run; add --apply to write)' };
  } catch (err) {
    return { id: 'projects', status: 'info', detail: `project tags not checked (${errorMessage(err)})` };
  } finally {
    if (db !== null) closeHippoDb(db);
  }
}

function nodeCheck(node: string): DoctorCheck {
  return versionAtLeast(node, MIN_NODE)
    ? { id: 'node', status: 'pass', detail: `Node.js ${node}` }
    : { id: 'node', status: 'fail', detail: `Node.js ${node} is older than ${MIN_NODE}`, fix: `Install Node.js ${MIN_NODE} or newer` };
}

interface StoreChoice {
  store: string | null;
  check: DoctorCheck;
}

/** The store the checks run against (project first, then global), and the check that says which. */
function storeCheck(local: string | null, globalRoot: string, hasGlobal: boolean): StoreChoice {
  if (local !== null && isInitialized(local)) {
    return { store: local, check: { id: 'store', status: 'pass', detail: `project store at ${local}${hasGlobal ? ` (global store at ${globalRoot} too)` : ''}` } };
  }
  if (local !== null) {
    // The walk stops at the first .hippo it finds, so a bare one (no hippo.db) blocks a parent or global store too.
    return { store: null, check: { id: 'store', status: 'fail', detail: `${local} has no hippo.db, so hippo commands run here stop at it`, fix: `run hippo init in ${path.dirname(local)}, or remove that .hippo folder` } };
  }
  if (hasGlobal) {
    return { store: globalRoot, check: { id: 'store', status: 'warn', detail: `no project store here; using the global store at ${globalRoot}`, fix: 'hippo init   (in the project root)' } };
  }
  return { store: null, check: { id: 'store', status: 'fail', detail: 'no hippo store found (project or global)', fix: 'hippo init   (in the project root), or hippo init --global' } };
}

function schemaCheck(have: number, want: number): DoctorCheck {
  return have === want
    ? { id: 'schema', status: 'pass', detail: `database schema v${have}` }
    : have > want
      ? { id: 'schema', status: 'fail', detail: `database schema v${have} is newer than this hippo (v${want})`, fix: 'npm install -g hippo-memory@latest' }
      : { id: 'schema', status: 'info', detail: `database schema v${have}; hippo migrates it to v${want} on the next write` };
}

function memoriesCheck(memories: number | null, dormant: number | null): DoctorCheck {
  const memoryCheck: DoctorCheck = { id: 'memories', status: 'info', detail: `${memories ?? '?'} memories${dormant !== null ? `, ${dormant} dormant` : ''}` };
  if (memories === 0) {
    memoryCheck.status = 'warn';
    memoryCheck.fix = 'hippo learn --git   (seed lessons from git history)';
  }
  return memoryCheck;
}

/** Whether the full-text index still matches `memories`; opening a current store no longer checks, so doctor reports and sleep repairs. */
function ftsCheck(fts: StoreHealth['fts']): DoctorCheck {
  if (!fts.ok) return { id: 'fts', status: 'warn', detail: `cannot read the full-text index: ${fts.message}` };
  const counts = fts.value;
  if (counts === null) return { id: 'fts', status: 'info', detail: 'no full-text index; search uses slower LIKE matching' };
  if (counts.memories === counts.fts) return { id: 'fts', status: 'pass', detail: `full-text index in sync (${counts.fts} rows)` };
  return {
    id: 'fts',
    status: 'warn',
    detail: `full-text index out of sync: ${counts.fts} indexed rows for ${counts.memories} memories, so search can miss memories or match removed ones`,
    fix: 'hippo sleep   (re-syncs the index)',
  };
}

function tokensCheck(tokens: StoreHealth['tokens']): DoctorCheck {
  if (!tokens.ok) {
    log.debug(`doctor: token ledger not read: ${tokens.message}`);
    return { id: 'tokens', status: 'info', detail: 'no token ledger yet (created on the next write)' };
  }
  const tally = tokens.value;
  return {
    id: 'tokens',
    status: 'info',
    detail: `${tally.injected} memory blocks sent to agents in 7 days, about ${tally.tokensSent} tokens sent and ${tally.tokensReread} re-read by later model calls (hippo tokens for detail)`,
  };
}

/** Checks that read the store's database; a store that cannot be opened becomes one failed schema check. */
function databaseChecks(store: string, now: Date): DoctorCheck[] {
  let health: StoreHealth;
  try {
    health = readStoreHealth(store, {
      since: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
      stuckBefore: new Date(now.getTime() - REPLAY_AFTER_MS).toISOString(),
      transcriptFloor: new Date(now.getTime() - TRANSCRIPT_FILL_WINDOW_MS).toISOString(),
    });
  } catch (err) {
    return [{
      id: 'schema',
      status: 'fail',
      detail: `cannot open the database: ${errorMessage(err)}`,
      fix: err instanceof IncompatibleBinaryError ? 'npm install -g hippo-memory@latest' : 'check file permissions on the .hippo folder',
    }];
  }
  return [
    schemaCheck(health.schemaVersion, getCurrentSchemaVersion()),
    memoriesCheck(health.memories, health.dormant),
    ftsCheck(health.fts),
    tokensCheck(health.tokens),
    failuresCheck(health.failures, health.schemaVersion),
    sleepCheck(health.lastSleep, now),
    compactionsCheck(health.compactions, store, now),
  ];
}

// Each hook and what it does, so a partial install says what is missing.
const CLAUDE_CODE_HOOKS: ReadonlyArray<readonly [string, string]> = [
  ['hippo context --pinned-only', 'per-prompt memory'],
  ['hippo session-end', 'session-end capture and sleep'],
  ['hippo pre-compact', 'compaction snapshot and memories request'],
  ['hippo compact-resume', 'resume after compaction'],
  ['hippo post-compact', 'saving the memories a compaction lists'],
  ['hippo capture-error', 'failed-tool capture'],
];

function claudeCodeCheck(home: string): DoctorCheck {
  const claudeDir = claudeConfigDir(home);
  if (!fs.existsSync(claudeDir)) {
    return { id: 'claude-code', status: 'info', detail: 'Claude Code not found; other agents can use hippo over MCP (hippo mcp)' };
  }
  const settings = readJson(path.join(claudeDir, 'settings.json'));
  const text = settings === null ? '' : JSON.stringify(settings);
  const viaPlugin = /hippo-memory@/.test(text);
  const missing = CLAUDE_CODE_HOOKS.filter(([marker]) => !text.includes(marker)).map(([, what]) => what);
  if (viaPlugin) {
    return { id: 'claude-code', status: 'pass', detail: 'Claude Code: hippo plugin enabled (all hooks, including compaction and failed-tool capture)' };
  }
  if (missing.length === 0) {
    return { id: 'claude-code', status: 'pass', detail: 'Claude Code: all hippo hooks installed, including compaction and failed-tool capture' };
  }
  if (missing.length === CLAUDE_CODE_HOOKS.length) {
    return { id: 'claude-code', status: 'warn', detail: 'Claude Code found, but no hippo hooks are installed', fix: 'hippo hook install claude-code' };
  }
  return { id: 'claude-code', status: 'warn', detail: `Claude Code: hippo hooks missing for ${missing.join(', ')}`, fix: 'hippo hook install claude-code   (adds only what is missing)' };
}

/** Run every check. Never throws for a broken install; broken parts become failed checks. */
export function runDoctor(opts: DoctorOpts): DoctorReport {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? new Date();
  const checks: DoctorCheck[] = [];

  checks.push(nodeCheck(opts.nodeVersion ?? process.versions.node));

  const local = findHippoStoreDir(cwd);
  const globalRoot = getGlobalRoot();
  const hasGlobal = isInitialized(globalRoot);
  const { store, check } = storeCheck(local, globalRoot, hasGlobal);
  checks.push(check);
  if (store !== null) checks.push(...databaseChecks(store, now));

  const holdoutRateBp = store === null ? 0 : loadConfig(store).pilot.holdoutRateBp;
  if (holdoutRateBp > 0) {
    checks.push({ id: 'pilot', status: 'info', detail: `pilot holdout on: about ${holdoutRateBp / 100}% of sessions get no memories pushed by hippo (pilot.holdoutRateBp=${holdoutRateBp})` });
  }
  if (hasGlobal) checks.push(projectsCheck(globalRoot));

  checks.push(claudeCodeCheck(home));

  if (isCodexPresent(home)) checks.push(codexCheck(home));

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
