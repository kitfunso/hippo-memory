/** `hippo doctor`: a read-only health check (never creates a store, installs a hook or migrates
 * a database). Every non-passing check names the command that fixes it, so an agent can act on
 * the `--json` output. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findHippoStoreDir, isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir, processHomes } from '../../host/agent-homes.js';
import type { Diagnostics } from '../../base/records/diagnostics.js';
import type { ProjectTagReads } from '../../base/records/project-tags.js';
import { loadConfig } from '../../host/config-file.js';
import { type SpoolFs } from '../../infra/spool-files.js';
import { isEmbeddingAvailable } from '../../base/embeddings/local.js';
import { CODEX_TRUST_LINE } from '../hooks-install/json-hooks.js';
import { isCodexPresent } from '../hooks-install/detect.js';
import { claudeConfigDir, codexHomeDir } from '../../base/util/agent-homes.js';
import { type JsonValue, isJsonObjectLiteral } from '../../base/util/json.js';
import { tryReadJsonFile } from '../../host/json-file.js';
import { databaseChecks, projectsCheck } from './doctor-store-checks.js';

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
export interface DoctorOptions {
  cwd?: string;
  /**
   * Home directory used to find agent configuration (~/.claude unless CLAUDE_CONFIG_DIR is set,
   * ~/.codex unless CODEX_HOME is).
   */
  home?: string;
  version: string;
  /** The tenant the CLI root resolved. */
  tenantId: string;
  nodeVersion?: string;
  now?: Date;
  /** Stands in for the fs the spool check reads; a test makes one call fail. */
  spoolFs?: SpoolFs;
  /** hippo.db's diagnostics under a folder doctor found; the caller's composition root opens the
   * store. */
  diagnosticsBodies: (hippoRoot: string) => DoctorStore;
}

/** What doctor reads of a store: its health and, for the global store, what a project repair
 * plans from. */
export type DoctorStore = { readonly diagnostics: Diagnostics } & ProjectTagReads;

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

// A missing or corrupt file is the finding doctor reports, so null is the answer.
function readJson(file: string): JsonValue | null {
  return tryReadJsonFile(file) ?? null;
}

// Trust lives in Codex's own config.toml rows; doctor reads only the hooks file and reminds.
function codexCheck(home: string): DoctorCheck {
  const file = path.join(codexHomeDir(home, processHomes().env), 'hooks.json');
  const parsed = readJson(file);
  // Codex drops every hook in a hooks.json it cannot parse, hippo's included.
  if (fs.existsSync(file) && !isJsonObjectLiteral(parsed)) {
    return {
      id: 'codex',
      status: 'warn',
      detail: "Codex's hooks.json is not a JSON object, so Codex runs no hook from it",
      fix: 'repair hooks.json, then run: hippo hook install codex',
    };
  }
  const text = JSON.stringify(parsed ?? '');
  const codexHooks: Array<[string, string]> = [
    ['hippo context --pinned-only', 'per-prompt memory'],
    ['hippo compact-resume', 'resume after compaction'],
  ];
  const missing = codexHooks.filter(([marker]) => !text.includes(marker)).map(([, what]) => what);
  if (missing.length === 0) {
    return {
      id: 'codex',
      status: 'pass',
      detail: `Codex: hippo memory hooks installed. ${CODEX_TRUST_LINE}`,
    };
  }
  return {
    id: 'codex',
    status: 'warn',
    detail:
      missing.length === codexHooks.length
        ? "Codex found, but hippo's memory hooks are not installed"
        : `Codex: hippo hooks missing for ${missing.join(', ')}`,
    fix: 'hippo hook install codex   (then trust the hooks once in /hooks)',
  };
}

function nodeCheck(node: string): DoctorCheck {
  return versionAtLeast(node, MIN_NODE)
    ? { id: 'node', status: 'pass', detail: `Node.js ${node}` }
    : {
        id: 'node',
        status: 'fail',
        detail: `Node.js ${node} is older than ${MIN_NODE}`,
        fix: `Install Node.js ${MIN_NODE} or newer`,
      };
}

interface StoreChoice {
  store: string | null;
  check: DoctorCheck;
}

/** The store the checks run against (project first, then global), and the check that says which. */
function storeCheck(local: string | null, globalRoot: string, hasGlobal: boolean): StoreChoice {
  if (local !== null && isInitialized(local)) {
    return {
      store: local,
      check: {
        id: 'store',
        status: 'pass',
        detail: `project store at ${local}${hasGlobal ? ` (global store at ${globalRoot} too)` : ''}`,
      },
    };
  }
  if (local !== null) {
    // The walk stops at the first .hippo it finds, so a bare one (no hippo.db) blocks a parent or
    // global store too.
    return {
      store: null,
      check: {
        id: 'store',
        status: 'fail',
        detail: `${local} has no hippo.db, so hippo commands run here stop at it`,
        fix: `run hippo init in ${path.dirname(local)}, or remove that .hippo folder`,
      },
    };
  }
  if (hasGlobal) {
    return {
      store: globalRoot,
      check: {
        id: 'store',
        status: 'warn',
        detail: `no project store here; using the global store at ${globalRoot}`,
        fix: 'hippo init   (in the project root)',
      },
    };
  }
  return {
    store: null,
    check: {
      id: 'store',
      status: 'fail',
      detail: 'no hippo store found (project or global)',
      fix: 'hippo init   (in the project root), or hippo init --global',
    },
  };
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
  const claudeDir = claudeConfigDir(home, processHomes().env);
  if (!fs.existsSync(claudeDir)) {
    return {
      id: 'claude-code',
      status: 'info',
      detail: 'Claude Code not found; other agents can use hippo over MCP (hippo mcp)',
    };
  }
  const settings = readJson(path.join(claudeDir, 'settings.json'));
  return claudeHooksCheck(settings === null ? '' : JSON.stringify(settings));
}

/** Grades the hooks from the settings file's text: the plugin, every hook, none, or some. */
function claudeHooksCheck(text: string): DoctorCheck {
  const viaPlugin = /hippo-memory@/.test(text);
  const missing = CLAUDE_CODE_HOOKS.filter(([marker]) => !text.includes(marker)).map(
    ([, what]) => what,
  );
  if (viaPlugin) {
    return {
      id: 'claude-code',
      status: 'pass',
      detail:
        'Claude Code: hippo plugin enabled (all hooks, including compaction and failed-tool capture)',
    };
  }
  if (missing.length === 0) {
    return {
      id: 'claude-code',
      status: 'pass',
      detail:
        'Claude Code: all hippo hooks installed, including compaction and failed-tool capture',
    };
  }
  if (missing.length === CLAUDE_CODE_HOOKS.length) {
    return {
      id: 'claude-code',
      status: 'warn',
      detail: 'Claude Code found, but no hippo hooks are installed',
      fix: 'hippo hook install claude-code',
    };
  }
  return {
    id: 'claude-code',
    status: 'warn',
    detail: `Claude Code: hippo hooks missing for ${missing.join(', ')}`,
    fix: 'hippo hook install claude-code   (adds only what is missing)',
  };
}

/** Run every check. Never throws for a broken install; broken parts become failed checks. */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const now = opts.now ?? new Date();
  const checks: DoctorCheck[] = [];

  checks.push(nodeCheck(opts.nodeVersion ?? process.versions.node));

  const local = findHippoStoreDir(cwd);
  const globalRoot = hippoHomeDir();
  const hasGlobal = isInitialized(globalRoot);
  const { store, check } = storeCheck(local, globalRoot, hasGlobal);
  checks.push(check);
  if (store !== null) {
    checks.push(...(await databaseChecks(opts.diagnosticsBodies(store), store, now, opts.spoolFs)));
  }

  const holdoutRateBp = store === null ? 0 : loadConfig(store).pilot.holdoutRateBp;
  if (holdoutRateBp > 0) {
    checks.push({
      id: 'pilot',
      status: 'info',
      detail:
        `pilot holdout on: about ${holdoutRateBp / 100}% of sessions get no memories pushed by hippo ` +
        `(pilot.holdoutRateBp=${holdoutRateBp})`,
    });
  }
  if (hasGlobal) {
    checks.push(await projectsCheck(opts.diagnosticsBodies(globalRoot), opts.tenantId));
  }

  checks.push(claudeCodeCheck(home));

  if (isCodexPresent(home)) checks.push(codexCheck(home));

  checks.push({
    id: 'embeddings',
    status: 'info',
    detail: isEmbeddingAvailable()
      ? 'local embeddings available (hybrid search)'
      : 'embeddings not installed; recall uses BM25 (optional: hippo embed --help)',
  });

  return { ok: !checks.some((c) => c.status === 'fail'), version: opts.version, store, checks };
}

/** Human-readable rendering of a {@link DoctorReport}. */
export function formatDoctor(report: DoctorReport): string {
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' } satisfies Record<
    DoctorStatus,
    string
  >;
  const lines = [`hippo ${report.version} doctor`, ''];
  for (const c of report.checks) {
    lines.push(`  [${mark[c.status]}] ${c.id.padEnd(11)} ${c.detail}`);
    if (c.fix && (c.status === 'warn' || c.status === 'fail')) {
      lines.push(`         ${''.padEnd(11)} fix: ${c.fix}`);
    }
  }
  lines.push('', report.ok ? 'No failures.' : 'Some checks failed; run the fix commands above.');
  return lines.join('\n');
}
