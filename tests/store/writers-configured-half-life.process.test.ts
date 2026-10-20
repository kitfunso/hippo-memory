// Every path that writes a new memory starts it on the store's configured default
// half-life, never the compiled one. Real stores and the built CLI; only the LLM fetch is stubbed.
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createMemory,
  deriveHalfLife,
  DEFAULT_HALF_LIFE_DAYS,
  Layer,
  type MemoryEntry,
} from '../../src/core/memory.js';
import * as api from '../../src/api/index.js';
import { consolidate } from '../../src/index.js';
import { buildDag, buildEntityProfiles } from '../../src/consolidate/dag.js';
import { storeExtractedFacts } from '../../src/learn/extract.js';
import { importGenericFile, importVault } from '../../src/entry/importers.js';
import { cmdCapture } from '../../src/capture/command.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { importProjectMemories } from '../../src/agent-memories/sync.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { loadConfig } from '../../src/core/config.js';
import { sqliteAgentImport } from '../../src/store/sqlite/agent-import.js';
import { writeEntry, loadAllEntries, readEntry, appendSessionEvent } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const HIPPO_BIN = path.resolve(__dirname, '..', '..', 'bin', 'hippo.js');
const CONFIGURED = 730;

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-writer-hl-'));
  dirs.push(dir);
  return dir;
}

function store(): string {
  const root = path.join(tmp(), '.hippo');
  initTestStore(root);
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ defaultHalfLifeDays: CONFIGURED, replay: { count: 0 } }),
  );
  return root;
}

/** `hippo <args>` run in this process from the store's project dir, the call bin/hippo.js makes; returns the exit code. */
async function hippoStatus(root: string, ...args: string[]): Promise<number> {
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  const saved = process.cwd();
  process.chdir(path.dirname(root));
  try {
    return (await runInProcess(() => runCli(['node', 'hippo', ...args]))).status;
  } finally {
    process.chdir(saved);
  }
}

async function hippo(root: string, ...args: string[]): Promise<void> {
  expect(await hippoStatus(root, ...args)).toBe(0);
}

function fetcher(text: string) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function seed(root: string, content: string, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  const entry = createMemory(content, { baseHalfLifeDays: CONFIGURED, ...opts });
  writeEntry(root, entry);
  return entry;
}

/** The memories `write` added to the store. */
async function added<T>(root: string, write: () => T): Promise<MemoryEntry[]> {
  const before = new Set(loadAllEntries(root, 'default').map((e) => e.id));
  await write();
  return loadAllEntries(root, 'default').filter((e) => !before.has(e.id));
}

const writers: [string, (root: string) => Promise<MemoryEntry[]>][] = [
  [
    'api supersede',
    (root) => {
      const old = seed(root, 'the deploy window is Tuesday afternoon');
      const ctx: FullContext = apiCtx(root, 'default', api.adminActor('cli'));
      return added(root, () => api.supersede(ctx, old.id, 'the deploy window is Thursday morning'));
    },
  ],
  [
    'CLI supersede',
    (root) => {
      const old = seed(root, 'the staging database lives in eu-west-1');
      return added(root, () => hippo(root, 'supersede', old.id, 'the staging database lives in eu-central-1'));
    },
  ],
  [
    'CLI trace record',
    (root) =>
      added(root, () =>
        hippo(
          root,
          'trace',
          'record',
          '--task',
          'deploy',
          '--steps',
          '[{"action":"build","observation":"ok"}]',
          '--outcome',
          'success',
        ),
      ),
  ],
  [
    'CLI learn --git',
    (root) => {
      const repo = path.dirname(root);
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
      git('add', 'a.txt');
      git('commit', '-q', '-m', 'fix: the parser dropped the trailing newline on windows paths during export');
      // A fresh process names the project from the repo made after the store; in process that git config is never read.
      return added(root, () =>
        execFileSync(process.execPath, [HIPPO_BIN, 'learn', '--git', '--days', '30'], {
          cwd: repo,
          env: { ...process.env, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
          stdio: 'ignore',
        }),
      );
    },
  ],
  [
    'CLI watch',
    (root) =>
      added(root, async () => {
        // watch exits with the watched command's code.
        expect(await hippoStatus(root, 'watch', '--', 'node', '-e', 'process.exit(3)')).toBe(3);
      }),
  ],
  [
    'Claude Code memory import',
    (root) => {
      const home = tmp();
      const project = fs.realpathSync.native(path.dirname(root)).replace(/[^a-zA-Z0-9]/g, '-');
      const memDir = path.join(home, '.claude', 'projects', project, 'memory');
      fs.mkdirSync(memDir, { recursive: true });
      fs.writeFileSync(
        path.join(memDir, 'lesson.md'),
        '---\nname: lesson\n---\nPrefer parameterized queries to string concatenation for SQL.\n',
      );
      return added(root, () =>
        importProjectMemories(root, {
          configAt: loadConfig,
          tenantId: 'default',
          agentImport: sqliteAgentImport({}),
          machine: { home, env: {}, platform: process.platform },
        }),
      );
    },
  ],
  [
    'capture',
    (root) => {
      const file = path.join(tmp(), 'session.txt');
      fs.writeFileSync(file, 'decision: rotate deploy keys every 90 days\n');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      return added(root, () =>
        cmdCapture(captureTarget(root), {
          tenantId: 'default',
          source: 'file',
          filePath: file,
          dryRun: false,
          global: false,
        }),
      );
    },
  ],
  [
    'file import',
    (root) => {
      const file = path.join(tmp(), 'notes.txt');
      fs.writeFileSync(file, 'The nightly backup runs at 02:00 UTC.\n\nRestores are tested every quarter.\n');
      return added(root, () => importGenericFile(file, { tenantId: 'default', hippoRoot: root }));
    },
  ],
  [
    'vault import result',
    async (root) => {
      const vault = tmp();
      fs.writeFileSync(path.join(vault, 'note.md'), 'The on-call rota changes every Monday at 09:00.\n');
      // The row itself goes through remember(); the result's copy must say what was stored.
      return (await importVault(vault, { tenantId: 'default', hippoRoot: root, name: 'notes' })).entries;
    },
  ],
  [
    'extracted facts',
    (root) => {
      const source = seed(root, 'Alice prefers dark mode and vim keybindings');
      return added(root, () =>
        storeExtractedFacts(
          sqliteSyncStore(root).localFiles.learning,
          source,
          [{ content: 'Alice prefers dark mode', tags: ['speaker:alice'], valence: 'neutral' }],
          loadConfig(root).defaultHalfLifeDays,
        ),
      );
    },
  ],
  [
    'sleep: auto-promoted trace',
    (root) => {
      appendSessionEvent(root, 'default', {
        session_id: 's1',
        event_type: 'action',
        content: 'ran the migration',
        source: 'agent',
      });
      appendSessionEvent(root, 'default', {
        session_id: 's1',
        event_type: 'session_complete',
        content: 'success',
        source: 'agent',
        metadata: { summary: 'migrated the billing table' },
      });
      return added(root, () => consolidate(root, { now: new Date() }));
    },
  ],
  [
    'sleep: merged semantic',
    (root) => {
      const backbone = 'rotate the staging tls certificates before expiry';
      seed(root, backbone, { layer: Layer.Episodic });
      seed(root, `${backbone} and notify the on-call channel`, { layer: Layer.Episodic });
      return added(root, () => consolidate(root, { dryRun: false }));
    },
  ],
  [
    'DAG summary',
    (root) => {
      const facts = ['alice filed X', 'alice noted Y', 'alice closed Z'].map((c) =>
        seed(root, c, { layer: Layer.Episodic, dagLevel: 1, tags: ['extracted', 'speaker:alice'] }),
      );
      return added(root, () =>
        buildDag(sqliteSyncStore(root).localFiles, facts, {
          baseHalfLifeDays: loadConfig(root).defaultHalfLifeDays,
          apiKey: 'test-key',
          fetcher: fetcher('alice files, notes and closes tickets'),
        }),
      );
    },
  ],
  [
    'DAG entity profile',
    (root) => {
      const l2s = ['alice prefers python type hints', 'alice owns the API layer'].map((c) =>
        seed(root, c, {
          layer: Layer.Semantic,
          tags: ['speaker:alice', 'dag-summary'],
          confidence: 'inferred',
          dagLevel: 2,
        }),
      );
      return added(root, () =>
        buildEntityProfiles(sqliteSyncStore(root).localFiles, l2s, {
          baseHalfLifeDays: loadConfig(root).defaultHalfLifeDays,
          apiKey: 'test-key',
          fetcher: fetcher('alice is the typed-python API owner'),
        }),
      );
    },
  ],
];

describe('writers on a configured default half-life', () => {
  it.each(writers)('%s starts the new memory on the configured default', async (name, write) => {
    const root = store();
    const written = await write(root);
    // The file import splits its two paragraphs into two rows; every other writer makes one row from its seed.
    expect(written).toHaveLength(name === 'file import' ? 2 : 1);
    for (const entry of written) {
      expect(entry.halfLifeDays).toBe(deriveHalfLife(CONFIGURED, entry));
      expect(readEntry(root, entry.id)?.halfLifeDays).toBe(entry.halfLifeDays);
    }
  });

  it('keeps the compiled default distinct from the configured one, so the table can fail', () => {
    expect(DEFAULT_HALF_LIFE_DAYS).not.toBe(CONFIGURED);
  });
});

describe('an invalid configured default half-life', () => {
  it.each([0, -30, 'forever'])('%s warns, and writers fall back to the built-in default', async (value) => {
    const root = store();
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ defaultHalfLifeDays: value, replay: { count: 0 } }),
    );
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const old = seed(root, 'the deploy window is Tuesday afternoon');
    const ctx: FullContext = apiCtx(root, 'default', api.adminActor('cli'));
    const [entry] = await added(root, () => api.supersede(ctx, old.id, 'the deploy window is Thursday morning'));
    expect(entry.halfLifeDays).toBe(deriveHalfLife(DEFAULT_HALF_LIFE_DAYS, entry));
    expect(warn.mock.calls.some((args) => String(args[0]).includes('"defaultHalfLifeDays"'))).toBe(true);
  });
});
