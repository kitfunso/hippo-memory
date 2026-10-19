// Pins the bytes of each format that names a memory's fields, for one entry with every field set: MemoryEntry's
// field names may change, and no stored or printed key may change with them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import { cliStdioHost } from '../../src/cli/api-context.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import { deserializeEntry } from '../../src/core/markdown.js';
import type { MemoryEntry } from '../../src/core/memory.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { handleMcpRequest, _resetSessionRecallHistoryMcpForTests } from '../../src/mcp/server.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { initStore } from '../../src/store/sqlite/handles.js';
import { listDormantSnapshots } from '../_helpers/dormant-snapshots.js';
import { everyFieldEntry, GOLDEN_TENANT, recallableEntry } from '../_helpers/every-field-entry.js';
import { makeRoot } from '../_helpers/make-root.js';
import { CLEARED_ENV, FAKE_NOW } from '../_helpers/recall-golden-seed.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { runInProcess, type InProcessResult } from '../_helpers/run-in-process.js';

const savedCwd = process.cwd();
let base: string;
let root: string;

/** Writes the entry, then the three summary columns a row write leaves to sleep. */
function seed(): void {
  const entry = everyFieldEntry();
  writeEntry(root, entry);
  writeEntry(root, recallableEntry());
  const db = openHippoDb(root);
  try {
    db.prepare('UPDATE memories SET summary_dirty = 1, last_rebuilt_at = ?, rebuild_count = ? WHERE id = ?').run(
      entry.lastRebuiltAt ?? null,
      entry.rebuildCount ?? 0,
      entry.id,
    );
  } finally {
    closeHippoDb(db);
  }
}

beforeEach(() => {
  base = makeRoot('wire-golden');
  root = path.join(base, '.hippo');
  initStore(root);
  for (const k of CLEARED_ENV) vi.stubEnv(k, '');
  vi.stubEnv('HIPPO_HOME', path.join(base, 'global'));
  vi.stubEnv('HIPPO_TENANT', GOLDEN_TENANT);
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  _resetAblationCacheForTests();
  _resetSessionRecallHistoryMcpForTests();
  process.chdir(base);
  seed();
});

afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

const run = (...args: string[]): Promise<InProcessResult> => runInProcess(() => runCli(['node', 'hippo', ...args]));

async function stdoutOf(...args: string[]): Promise<string> {
  const r = await run(...args);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe('memory wire goldens', () => {
  it('markdown mirror: front matter bytes, and the entry it reads back', () => {
    const file = fs.readFileSync(path.join(root, 'episodic', `${everyFieldEntry().id}.md`), 'utf8');
    expect(file).toMatchSnapshot();
    // The mirror carries no DAG cache and no search score, so those read back absent.
    const expected: MemoryEntry = {
      ...everyFieldEntry(),
      descendantCount: undefined,
      earliestAt: undefined,
      latestAt: undefined,
      summaryDirty: undefined,
      lastRebuiltAt: undefined,
      rebuildCount: undefined,
      dagLevel3BuiltAt: undefined,
      bm25Score: undefined,
    };
    expect(deserializeEntry(file)).toEqual(expected);
  });

  it('dormant snapshot: entry_json bytes, and the entry it restores', () => {
    const db = openHippoDb(root);
    try {
      insertDormantRow(db, { entry: everyFieldEntry(), reason: 'decay', strength: 0.01, dormantAt: FAKE_NOW });
      // SAFETY: the SELECT names the one column read, and the insert above made the row.
      const row = db.prepare('SELECT entry_json FROM dormant_memories WHERE id = ?').get(everyFieldEntry().id) as {
        entry_json: string;
      };
      expect(row.entry_json).toMatchSnapshot();
      const [snapshot] = listDormantSnapshots(db, GOLDEN_TENANT);
      expect(snapshot?.entry).toEqual(everyFieldEntry());
    } finally {
      closeHippoDb(db);
    }
  });

  it('hippo export: the JSON dump', async () => {
    expect(await stdoutOf('export')).toMatchSnapshot();
  });

  it('hippo trace --json', async () => {
    expect(await stdoutOf('trace', everyFieldEntry().id, '--json')).toMatchSnapshot();
  });

  it('hippo recall --json --why', async () => {
    expect(await stdoutOf('recall', 'haddock', '--json', '--why')).toMatchSnapshot();
  });

  it('MCP hippo_recall text', async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_recall', arguments: { query: 'haddock' } },
      },
      { ...cliStdioHost.contextFor(root, GOLDEN_TENANT), project: { name: '', legacyName: '' } },
    );
    // SAFETY: a tools/call result is written by src/mcp/request.ts as { content: [{ text }], isError? }.
    const result = res?.result as { content?: { text: string }[] } | undefined;
    expect(result?.content?.[0]?.text ?? JSON.stringify(res?.error)).toMatchSnapshot();
  });
});
