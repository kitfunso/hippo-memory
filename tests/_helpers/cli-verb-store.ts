// One temp project with its own home and global store for the CLI verb tests: run a verb, then read what it printed and
// stored. Output names the temp folder `<tmp>`, ISO times `<ts>` and dates `<date>`, and drops Node's SQLite notice.
import { afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  createMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { ownStderr } from './own-stderr.js';
import { runInProcess } from './run-in-process.js';
import { runCliAs } from './run-cli-as.js';
import { hippoRunAsync } from './spawn-hippo.js';
import { writeEntry } from './root-forms.js';
import { initTestStore } from './store-template.js';

const SPAWN_MS = 60_000;
const STRENGTH_DECIMALS = 6;
// Wall-clock times a write stamps; a test cannot name them, so rows leave them out.
const VOLATILE_COLUMNS = ['created', 'last_retrieved', 'valid_from', 'updated_at'];
// Keys that pick a tenant, a scope, a session, a server, a clock or a home for the child, so the developer's shell cannot change a row.
const DROPPED_ENV = [
  'HIPPO_TENANT',
  'HIPPO_SCOPE',
  'GSTACK_SKILL',
  'OPENCLAW_SKILL',
  'HIPPO_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'HIPPO_API_KEY',
  'HIPPO_REQUIRE_SERVER',
  'HIPPO_STRICT_OWNER',
  'HIPPO_FAKE_NOW',
  'HIPPO_LOG',
  'XDG_DATA_HOME',
  'HIPPO_HOME',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'PATH',
];
// Counters and one-time repair marks a verb leaves in `meta`; the schema version and the like stay out, as they change with every migration.
const META_KEYS = ['total_remembered', 'total_forgotten', 'project_repair_auto', 'quality_repair_auto'];

const bases: string[] = [];
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

export type Row = Record<string, string | number | null>;
/** A column value, or the parsed JSON of a `*_json` column. */
export type Cell = string | number | boolean | null | readonly Cell[] | { readonly [key: string]: Cell };
/** A row as `rows()` and `auditMeta()` shape it. */
export type ParsedRow = Record<string, Cell>;
/** Which store a read looks at: the project's own, or the global one under the home folder. */
export type Where = 'local' | 'global';

/** One command's exit code and output. */
export interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// `remember` tags a row with each folder of the project path; Store fills that path with these four names.
export const PATH_TAGS: readonly string[] = ['path:acme', 'path:billing', 'path:ledger', 'path:app'];

/** What `remember` prints for the row it stored; a `--global` write adds the `[global] ` prefix. */
export function remembered(row: ParsedRow, prefix = ''): Ran {
  // SAFETY: tags_json holds a JSON array of tag strings.
  const tags = row['tags'] as readonly string[];
  const lines = [
    `${prefix}Remembered [${String(row['id'])}]`,
    `   Layer: ${String(row['layer'])} | Strength: ${Number(row['strength']).toFixed(2)} | ` +
      `Half-life: ${String(row['half_life_days'])}d | Confidence: ${String(row['confidence'])}`,
    `   Tags: ${tags.join(', ')}`,
    ...(row['pinned'] ? ['   Pinned (no decay)'] : []),
  ];
  return { status: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

export function query(root: string, sql: string, ...params: Array<string | number>): Row[] {
  // Opening a missing store would create it, and the cases on a folder with no store assert that none appears.
  if (!existsSync(join(root, 'hippo.db'))) return [];
  const db = openHippoDb(root);
  try {
    // SAFETY: node:sqlite answers each row as a plain column-keyed object.
    return db.prepare(sql).all(...params) as Row[];
  } finally {
    closeHippoDb(db);
  }
}

function childEnv(home: string, user: string): NodeJS.ProcessEnv {
  const dropped = new Set(DROPPED_ENV);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!dropped.has(key.toUpperCase())) env[key] = value;
  // The global npm folder holds the developer's own `hippo` and agent CLIs, which no case may start.
  const path = (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((dir) => !/[\\/]npm[\\/]?$/i.test(dir))
    .join(delimiter);
  return {
    ...env,
    PATH: path,
    HIPPO_HOME: home,
    HOME: user,
    USERPROFILE: user,
    APPDATA: join(user, 'AppData', 'Roaming'),
    HIPPO_SKIP_AUTO_INTEGRATIONS: '1',
  };
}

/** Every way a run spells the temp folder: as made and resolved (macOS reaches it through a symlink), with either slash, and JSON-escaped. */
function spellingsOf(base: string): string[] {
  const paths = [base, realpathSync(base), realpathSync.native(base)];
  const all = paths.flatMap((p) => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** A memory row less its time columns, each `*_json` column parsed under its name less the suffix (`tags`, `parents`). */
function parsed(row: Row): ParsedRow {
  const kept = Object.entries(row).filter(([column]) => !VOLATILE_COLUMNS.includes(column));
  return Object.fromEntries(
    kept.map(([column, value]) =>
      // SAFETY: a `*_json` column holds JSON text, and JSON parses to a Cell.
      column.endsWith('_json') && value !== null
        ? [column.slice(0, -5), JSON.parse(String(value)) as Cell]
        : [column, value],
    ),
  );
}

/** One temp project with its own global store and home. */
export class Store {
  readonly base = mkdtempSync(join(tmpdir(), 'hippo-cli-verb-'));
  // Four fixed folder names fill the path tags, so no tag carries the random temp name.
  readonly cwd = join(this.base, 'acme', 'billing', 'ledger', 'app');
  readonly root = join(this.cwd, '.hippo');
  readonly home = join(this.base, 'home');
  readonly env: NodeJS.ProcessEnv;
  private readonly spellings = spellingsOf(this.base);
  private auditMark = 0;
  private readonly spawned: boolean;

  /** `spawned` runs each command through the built CLI, which proves a real process prints what the in-process run does. */
  constructor(opts: { init?: boolean; global?: boolean; spawned?: boolean } = {}) {
    this.spawned = opts.spawned ?? false;
    bases.push(this.base);
    mkdirSync(this.cwd, { recursive: true });
    const user = join(this.base, 'user');
    mkdirSync(user);
    this.env = childEnv(this.home, user);
    if (opts.init !== false) initTestStore(this.root);
    if (opts.global) initTestStore(this.home);
    this.settle();
  }

  /** Rows a case seeds in process are setup: audit rows up to here stay out of `audit()`. */
  settle(): void {
    this.auditMark = Number(query(this.root, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_log')[0]?.['n'] ?? 0);
  }

  seed(content: string, options: Partial<CreateMemoryOptions> = {}, fields: Partial<MemoryEntry> = {}): string {
    const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options }), ...fields };
    writeEntry(this.root, entry);
    return entry.id;
  }

  /** A row with a fixed id, age and strength, for `sleep`, which decays from `created` against the fixed clock. */
  seedAged(
    id: string,
    created: string,
    content: string,
    options: Partial<CreateMemoryOptions> = {},
    fields: Partial<MemoryEntry> = {},
  ): void {
    this.seed(content, options, { id, created, lastRetrieved: created, validFrom: created, strength: 1, ...fields });
  }

  async run(...args: string[]): Promise<Ran> {
    const opts = { cwd: this.cwd, env: this.env };
    // Async in both modes, so a run that calls a server this process holds leaves the thread free to answer.
    const r = this.spawned ? await hippoRunAsync(args, { ...opts, timeout: SPAWN_MS }) : await runCliAs(args, opts);
    return { status: r.status, stdout: this.mask(r.stdout), stderr: this.mask(ownStderr(r.stderr)) };
  }

  /** A verb function with no flag for its test seam (the refine fetcher), run in this process with its output captured. */
  async call<T>(fn: () => Promise<T>): Promise<Ran & { result: T | undefined }> {
    let result: T | undefined;
    const r = await runInProcess(async () => {
      result = await fn();
    });
    return { status: r.status, stdout: this.mask(r.stdout), stderr: this.mask(r.stderr), result };
  }

  /** The newest row's id. */
  lastId(): string {
    return String(query(this.root, 'SELECT id FROM memories ORDER BY rowid DESC LIMIT 1')[0]!['id']);
  }

  private mask(text: string): string {
    let out = text.replace(/\r\n/g, '\n');
    for (const spelled of this.spellings) out = out.replaceAll(spelled, '<tmp>');
    return out
      .replace(/<tmp>[^\s"'`]*/g, (path) => path.replace(/\\+/g, '/'))
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>')
      .replace(/\b\d{4}-\d\d-\d\d\b/g, '<date>');
  }

  private rootOf(where: Where): string {
    return where === 'local' ? this.root : this.home;
  }

  /** Every memory row of one store in write order, as `parsed` shapes it. */
  rows(where: Where = 'local'): ParsedRow[] {
    return query(this.rootOf(where), 'SELECT * FROM memories ORDER BY rowid').map((row) => {
      // Strength decays from `created`, so the stored value carries the microseconds the write took.
      return { ...parsed(row), strength: Number(Number(row['strength']).toFixed(STRENGTH_DECIMALS)) };
    });
  }

  /** Each audit row the case wrote, as `tenant actor op [target]`; the project store skips the rows before `settle()`. */
  audit(where: Where = 'local'): string[] {
    return this.auditRows(where).map((a) =>
      [a.tenant_id, a.actor, a.op, a.target_id].filter((p) => p != null).join(' '),
    );
  }

  /** The parsed metadata of the rows `audit()` lists, in the same order. */
  auditMeta(where: Where = 'local'): ParsedRow[] {
    // SAFETY: every audit writer stores a JSON object in metadata_json.
    return this.auditRows(where).map((a) => JSON.parse(String(a.metadata_json)) as ParsedRow);
  }

  private auditRows(where: Where): Row[] {
    const sql = 'SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE id > ? ORDER BY id';
    return query(this.rootOf(where), sql, where === 'local' ? this.auditMark : 0);
  }

  /** The counters and repair marks a verb leaves in one store's `meta`. */
  counters(where: Where = 'local'): Record<string, string> {
    const keys = META_KEYS.map((key) => `'${key}'`).join(', ');
    const rows = query(this.rootOf(where), `SELECT key, value FROM meta WHERE key IN (${keys}) ORDER BY key`);
    return Object.fromEntries(rows.map((r) => [String(r['key']), String(r['value'])]));
  }

  storeMade(): boolean {
    return existsSync(join(this.root, 'hippo.db'));
  }
}
