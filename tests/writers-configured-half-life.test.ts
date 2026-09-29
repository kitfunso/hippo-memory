// Every path that writes a new memory starts it on the store's configured default
// half-life, never the compiled one. Real stores and the built CLI; only the LLM fetch is stubbed.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore, writeEntry, loadAllEntries, readEntry, appendSessionEvent } from '../src/store.js';
import { createMemory, deriveHalfLife, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../src/memory.js';
import * as api from '../src/api.js';
import { consolidate } from '../src/consolidate.js';
import { buildDag, buildEntityProfiles } from '../src/dag.js';
import { storeExtractedFacts } from '../src/extract.js';
import { importGenericFile, importVault } from '../src/importers.js';
import { cmdCapture } from '../src/capture.js';
import { importProjectMemories } from '../src/agent-memories/sync.js';

const HIPPO_BIN = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const CONFIGURED = 730;

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-writer-hl-'));
  dirs.push(dir);
  return dir;
}

function store(): string {
  const root = path.join(tmp(), '.hippo');
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: CONFIGURED, replay: { count: 0 } }));
  return root;
}

function hippo(root: string, ...args: string[]): void {
  execFileSync(process.execPath, [HIPPO_BIN, ...args], {
    cwd: path.dirname(root),
    env: { ...process.env, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    stdio: 'ignore',
  });
}

function fetcher(text: string) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ content: [{ text }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function seed(root: string, content: string, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  const entry = createMemory(content, { baseHalfLifeDays: CONFIGURED, ...opts });
  writeEntry(root, entry);
  return entry;
}

/** The memories `write` added to the store. */
async function added<T>(root: string, write: () => T): Promise<MemoryEntry[]> {
  const before = new Set(loadAllEntries(root).map((e) => e.id));
  await write();
  return loadAllEntries(root).filter((e) => !before.has(e.id));
}

const writers: [string, (root: string) => Promise<MemoryEntry[]>][] = [
  ['api supersede', (root) => {
    const old = seed(root, 'the deploy window is Tuesday afternoon');
    const ctx: api.Context = { hippoRoot: root, tenantId: 'default', actor: api.adminActor('cli') };
    return added(root, () => api.supersede(ctx, old.id, 'the deploy window is Thursday morning'));
  }],
  ['CLI supersede', (root) => {
    const old = seed(root, 'the staging database lives in eu-west-1');
    return added(root, () => hippo(root, 'supersede', old.id, 'the staging database lives in eu-central-1'));
  }],
  ['CLI trace record', (root) => added(root, () =>
    hippo(root, 'trace', 'record', '--task', 'deploy', '--steps', '[{"action":"build","observation":"ok"}]', '--outcome', 'success'))],
  ['CLI learn --git', (root) => {
    const repo = path.dirname(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'fix: the parser dropped the trailing newline on windows paths during export');
    return added(root, () => hippo(root, 'learn', '--git', '--days', '30'));
  }],
  ['CLI watch', (root) => added(root, () => {
    // watch exits with the watched command's code, so a failing command throws here.
    expect(() => hippo(root, 'watch', 'node -e "process.exit(3)"')).toThrow();
  })],
  ['Claude Code memory import', (root) => {
    const home = tmp();
    const project = fs.realpathSync.native(path.dirname(root)).replace(/[^a-zA-Z0-9]/g, '-');
    const memDir = path.join(home, '.claude', 'projects', project, 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'lesson.md'), '---\nname: lesson\n---\nPrefer parameterized queries to string concatenation for SQL.\n');
    return added(root, () => importProjectMemories(root, { machine: { home, env: {}, platform: process.platform } }));
  }],
  ['capture', (root) => {
    const file = path.join(tmp(), 'session.txt');
    fs.writeFileSync(file, 'decision: rotate deploy keys every 90 days\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return added(root, () => cmdCapture(root, { source: 'file', filePath: file, dryRun: false, global: false }));
  }],
  ['file import', (root) => {
    const file = path.join(tmp(), 'notes.txt');
    fs.writeFileSync(file, 'The nightly backup runs at 02:00 UTC.\n\nRestores are tested every quarter.\n');
    return added(root, () => importGenericFile(file, { hippoRoot: root }));
  }],
  ['vault import result', async (root) => {
    const vault = tmp();
    fs.writeFileSync(path.join(vault, 'note.md'), 'The on-call rota changes every Monday at 09:00.\n');
    // The row itself goes through remember(); the result's copy must say what was stored.
    return importVault(vault, { hippoRoot: root, name: 'notes' }).entries;
  }],
  ['extracted facts', (root) => {
    const source = seed(root, 'Alice prefers dark mode and vim keybindings');
    return added(root, () => storeExtractedFacts(root, source, [{ content: 'Alice prefers dark mode', tags: ['speaker:alice'], valence: 'neutral' }]));
  }],
  ['sleep: auto-promoted trace', (root) => {
    appendSessionEvent(root, 'default', { session_id: 's1', event_type: 'action', content: 'ran the migration', source: 'agent' });
    appendSessionEvent(root, 'default', { session_id: 's1', event_type: 'session_complete', content: 'success', source: 'agent', metadata: { summary: 'migrated the billing table' } });
    return added(root, () => consolidate(root, { now: new Date() }));
  }],
  ['sleep: merged semantic', (root) => {
    const backbone = 'rotate the staging tls certificates before expiry';
    seed(root, backbone, { layer: Layer.Episodic });
    seed(root, `${backbone} and notify the on-call channel`, { layer: Layer.Episodic });
    return added(root, () => consolidate(root, { dryRun: false }));
  }],
  ['DAG summary', (root) => {
    const facts = ['alice filed X', 'alice noted Y', 'alice closed Z'].map((c) =>
      seed(root, c, { layer: Layer.Episodic, dag_level: 1, tags: ['extracted', 'speaker:alice'] }));
    return added(root, () => buildDag(root, facts, { apiKey: 'test-key', fetcher: fetcher('alice files, notes and closes tickets') }));
  }],
  ['DAG entity profile', (root) => {
    const l2s = ['alice prefers python type hints', 'alice owns the API layer'].map((c) =>
      seed(root, c, { layer: Layer.Semantic, tags: ['speaker:alice', 'dag-summary'], confidence: 'inferred', dag_level: 2 }));
    return added(root, () => buildEntityProfiles(root, l2s, { apiKey: 'test-key', fetcher: fetcher('alice is the typed-python API owner') }));
  }],
];

describe('writers on a configured default half-life', () => {
  it.each(writers)('%s starts the new memory on the configured default', async (_path, write) => {
    const root = store();
    const written = await write(root);
    expect(written.length).toBeGreaterThan(0);
    for (const entry of written) {
      expect(entry.half_life_days).toBe(deriveHalfLife(CONFIGURED, entry));
      expect(readEntry(root, entry.id)?.half_life_days).toBe(entry.half_life_days);
    }
  });

  it('keeps the compiled default distinct from the configured one, so the table can fail', () => {
    expect(DEFAULT_HALF_LIFE_DAYS).not.toBe(CONFIGURED);
  });
});

describe('an invalid configured default half-life', () => {
  it.each([0, -30, 'forever'])('%s warns, and writers fall back to the built-in default', async (value) => {
    const root = store();
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: value, replay: { count: 0 } }));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = seed(root, 'the deploy window is Tuesday afternoon');
    const ctx: api.Context = { hippoRoot: root, tenantId: 'default', actor: api.adminActor('cli') };
    const [entry] = await added(root, () => api.supersede(ctx, old.id, 'the deploy window is Thursday morning'));
    expect(entry.half_life_days).toBe(deriveHalfLife(DEFAULT_HALF_LIFE_DAYS, entry));
    expect(warn.mock.calls.some((args) => String(args[0]).includes('"defaultHalfLifeDays"'))).toBe(true);
  });
});
