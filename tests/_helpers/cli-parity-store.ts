// One temp project with its own home and global store for the spawned-CLI parity tests, with the masks that make a run repeatable.
// Masked: the temp folder, memory ids, ISO timestamps, calendar dates, Node's SQLite notice, four time columns; strength is rounded.
import { afterAll, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions, type MemoryEntry } from '../../src/core/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { initStore } from '../../src/store/open.js';
import { ownStderr } from './own-stderr.js';
import { runInProcess } from './run-in-process.js';
import { hippoRun, hippoRunAsync } from './spawn-hippo.js';

const SPAWN_MS = 60_000;
// Keys that pick a tenant, a scope, a session, a server, a clock or a home for the child, so the developer's shell cannot change a row.
const DROPPED_ENV = [
  'HIPPO_TENANT', 'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_API_KEY',
  'HIPPO_REQUIRE_SERVER', 'HIPPO_STRICT_OWNER', 'HIPPO_FAKE_NOW', 'HIPPO_LOG', 'XDG_DATA_HOME', 'HIPPO_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'PATH',
];
const VOLATILE_COLUMNS = ['created', 'last_retrieved', 'valid_from', 'updated_at'];
const STRENGTH_DECIMALS = 6;
// Counters and one-time repair marks a verb leaves in `meta`; the schema version and the like stay out, as they change with every migration.
const META_KEYS = ['total_remembered', 'total_forgotten', 'project_repair_auto', 'quality_repair_auto'];
const AUDIT_COLUMNS = 'tenant_id, actor, op, target_id, metadata_json';

const bases: string[] = [];
afterAll(() => {
  for (const base of bases) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

export type Row = Record<string, string | number | null>;

/** State a case names itself, pinned beside the rows every case pins. */
export interface ExtraState {
  decisions?: Row[];
  rereadLog?: string[];
  ledger?: { local: Row[]; global: Row[] };
  globalCounter?: Row[];
  rows?: Row[];
  vectors?: string[];
}

export function query(root: string, sql: string, ...params: Array<string | number>): Row[] {
  // Opening a missing store would create it, and the cases on a folder with no store pin that none appears.
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
  const path = (process.env['PATH'] ?? '').split(delimiter).filter((dir) => !/[\\/]npm[\\/]?$/i.test(dir)).join(delimiter);
  return { ...env, PATH: path, HIPPO_HOME: home, HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData', 'Roaming'), HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
}

/** Every way a run spells the temp folder: as made and resolved (macOS reaches it through a symlink), with either slash, and JSON-escaped. */
function spellingsOf(base: string): string[] {
  const paths = [base, realpathSync(base), realpathSync.native(base)];
  const all = paths.flatMap((p) => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** One temp project with its own global store and home; `run`, `runAsync` and `call` append each exit code and output to the transcript. */
export class Store {
  readonly base = mkdtempSync(join(tmpdir(), 'hippo-cli-parity-'));
  // Four fixed folder names fill the path tags, so no tag carries the random temp name.
  readonly cwd = join(this.base, 'acme', 'billing', 'ledger', 'app');
  readonly root = join(this.cwd, '.hippo');
  readonly home = join(this.base, 'home');
  readonly env: NodeJS.ProcessEnv;
  private readonly spellings = spellingsOf(this.base);
  private readonly ids = new Map<string, string>();
  private readonly transcript: string[] = [];
  private auditMark = 0;

  constructor(opts: { init?: boolean; global?: boolean } = {}) {
    bases.push(this.base);
    mkdirSync(this.cwd, { recursive: true });
    const user = join(this.base, 'user');
    mkdirSync(user);
    this.env = childEnv(this.home, user);
    if (opts.init !== false) initStore(this.root);
    if (opts.global) initStore(this.home);
    this.settle();
  }

  /** Rows a case seeds in process are setup: audit rows up to here stay out of the record. */
  settle(): void {
    this.auditMark = Number(query(this.root, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_log')[0]?.['n'] ?? 0);
  }

  seed(content: string, options: Partial<CreateMemoryOptions> = {}, fields: Partial<MemoryEntry> = {}): string {
    const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options }), ...fields };
    writeEntry(this.root, entry);
    return entry.id;
  }

  /** A row with a fixed id, age and strength, for `sleep`, which decays from `created` against the fixed clock. */
  seedAged(id: string, created: string, content: string, options: Partial<CreateMemoryOptions> = {}, fields: Partial<MemoryEntry> = {}): void {
    this.seed(content, options, { id, created, last_retrieved: created, valid_from: created, strength: 1, ...fields });
  }

  private record(args: readonly string[], r: { status: number | null; stdout: string; stderr: string }): void {
    this.transcript.push(`$ hippo ${args.join(' ')} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${ownStderr(r.stderr)}`);
  }

  run(...args: string[]): void {
    const r = hippoRun(args, { cwd: this.cwd, env: this.env, timeout: SPAWN_MS });
    expect(r.error, `spawn ${args.join(' ')}`).toBeUndefined();
    this.record(args, r);
  }

  /** `run` with the test thread left free, for a child that calls a server this process runs. */
  async runAsync(...args: string[]): Promise<void> {
    this.record(args, await hippoRunAsync(args, { cwd: this.cwd, env: this.env, timeout: SPAWN_MS }));
  }

  /** A verb function with no flag for its test seam (the refine fetcher), run in this process with its output captured. */
  async call<T>(label: string, fn: () => Promise<T>): Promise<void> {
    let answer: T | undefined;
    const r = await runInProcess(async () => { answer = await fn(); });
    this.transcript.push(`$ ${label} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}--- result\n${JSON.stringify(answer, null, 1)}\n`);
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
      .replace(/\b(?:mem|sem)_[0-9a-f]{12}\b/g, (id) => {
        if (!this.ids.has(id)) this.ids.set(id, `id#${this.ids.size + 1}`);
        return this.ids.get(id)!;
      })
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>')
      .replace(/\b\d{4}-\d\d-\d\d\b/g, '<date>');
  }

  private memories(root: string): Row[] {
    return query(root, 'SELECT * FROM memories ORDER BY rowid').map((row) => {
      for (const column of VOLATILE_COLUMNS) delete row[column];
      // Strength decays from `created`, so the stored value carries the microseconds the write took.
      return { ...row, strength: Number(Number(row['strength']).toFixed(STRENGTH_DECIMALS)) };
    });
  }

  /** Four snapshots, so a change to the audit rows alone shows as that and nothing else; `extra` is state the case names itself. */
  expectPinned(extra: ExtraState = {}): void {
    expect(this.mask(this.transcript.join('\n'))).toMatchSnapshot('output');
    expect(this.mask(JSON.stringify({ local: this.memories(this.root), global: this.memories(this.home) }, null, 1))).toMatchSnapshot('memory rows');
    const audit = {
      local: query(this.root, `SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE id > ? ORDER BY id`, this.auditMark),
      global: query(this.home, `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY id`),
    };
    expect(this.mask(JSON.stringify(audit, null, 1))).toMatchSnapshot('audit rows');
    const other = {
      storeMade: existsSync(join(this.root, 'hippo.db')),
      meta: query(this.root, `SELECT key, value FROM meta WHERE key IN (${META_KEYS.map((key) => `'${key}'`).join(', ')}) ORDER BY key`),
      ...extra,
    };
    expect(this.mask(JSON.stringify(other, null, 1))).toMatchSnapshot('other state');
  }
}
