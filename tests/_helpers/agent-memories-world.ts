// Scratch homes, projects and stores for the agent memory sync tests; nothing here reads the real home.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminActor, type HippoDbContext } from '../../src/api/index.js';
import { claudeFolderName } from '../../src/agent-memories/claude-code.js';
import { emptyTally, totalTally, type ImportReport, type Tally } from '../../src/agent-memories/report.js';
import type { Machine } from '../../src/agent-memories/sync.js';
import type { ToolId } from '../../src/core/agent-memory-tools.js';
import { queryAuditEvents, type AuditOp } from '../../src/store/audit.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { loadDormantMemories, type DormantMemory } from '../../src/store/dormant.js';
import type { MemoryEntry } from '../../src/core/memory.js';
import { initStore, isInitialized } from '../../src/store/open.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';

export interface World {
  readonly dir: string;
  readonly home: string;
  readonly project: string;
  readonly local: string;
  readonly global: string;
  readonly machine: Machine;
  readonly savedHippoHome: string | undefined;
}

/** A scratch home, a project with its own store, and HIPPO_HOME pointed at a global store that does not exist yet. */
export function openWorld(): World {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-agentmem-sync-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const project = join(dir, 'proj');
  const local = join(project, '.hippo');
  initStore(local);
  const world = { dir, home, project, local, global: join(dir, 'global'), machine: { home, env: {}, platform: process.platform }, savedHippoHome: process.env.HIPPO_HOME };
  process.env.HIPPO_HOME = world.global;
  return world;
}

export function closeWorld(w: World): void {
  if (w.savedHippoHome === undefined) delete process.env.HIPPO_HOME;
  else process.env.HIPPO_HOME = w.savedHippoHome;
  rmSync(w.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function note(dir: string, file: string, body: string, yaml = 'type: feedback'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `---\n${yaml}\n---\n${body}\n`, 'utf8');
  return path;
}

/** The folder Claude Code keeps a project's notes in, under the world's home. */
export const projectNotes = (w: World, project = w.project): string => join(w.home, '.claude', 'projects', claudeFolderName(project), 'memory');

/** Claude Code's user folder is whatever `autoMemoryDirectory` in its user settings names. */
export function userNotes(w: World): string {
  const dir = join(w.home, 'automem');
  mkdirSync(join(w.home, '.claude'), { recursive: true });
  writeFileSync(join(w.home, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: dir }), 'utf8');
  return dir;
}

/** A Codex memory summary; the lines follow its `## User Profile` heading. */
export function codexSummary(w: World, ...lines: string[]): string {
  const file = join(w.home, '.codex', 'memories', 'memory_summary.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, ['v1', '', '## User Profile', '', ...lines, ''].join('\n'), 'utf8');
  return file;
}

/** A store config naming its agent memory tools (null is every tool), with embeddings off. */
export function writeConfig(root: string, tools: readonly string[] | null): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ agentMemories: { tools }, embeddings: { enabled: false } }), 'utf8');
}

export const agentRows = (root: string): MemoryEntry[] =>
  isInitialized(root) ? loadAllEntries(root).filter((e) => e.source.startsWith('agent-memory:')) : [];

export const liveRows = (root: string): MemoryEntry[] => agentRows(root).filter((e) => !e.superseded_by);

export const liveTexts = (root: string): string[] => liveRows(root).map((e) => e.content).sort();

export function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

export const dormantRows = (root: string): DormantMemory[] =>
  isInitialized(root) ? loadDormantMemories(root, 'default', { limit: 1000 }) : [];

export const auditCount = (root: string, op: AuditOp): number =>
  withDb(root, (db) => queryAuditEvents(db, { tenantId: 'default', op, limit: 10000 }).length);

export function auditTotal(root: string): number {
  // SAFETY: the SELECT names one aliased COUNT column.
  const row = withDb(root, (db) => db.prepare('SELECT COUNT(*) AS n FROM audit_log').get()) as { n: number };
  return Number(row.n);
}

export const toolTally = (report: ImportReport, tool: ToolId): Tally => report.tools.find((t) => t.tool === tool)?.tally ?? emptyTally();

export const tally = (report: ImportReport): Tally => totalTally(report);

export const ctxFor = (root: string): HippoDbContext => ({ hippoRoot: root, tenantId: 'default', actor: adminActor('test') });

export const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Design 3's container id, worked out here rather than taken from the code under test. */
export function expectedContainer(dir: string, scope: 'p' | 'u'): string {
  const real = realpathSync.native(dir).replace(/\\/g, '/');
  return `${scope}-${sha(process.platform === 'win32' ? real.toLowerCase() : real).slice(0, 12)}`;
}

const REPO = resolve(import.meta.dirname, '..', '..');

export const distUrl = (rel: string): string => pathToFileURL(join(REPO, 'dist', rel)).href;
