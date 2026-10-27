// A note whose file name holds a secret keeps one stable identity that holds no secret, in the row source and in the plan.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEntry, writeEntry } from '../_helpers/root-forms.js';
import { importForStore } from '../../src/api/agent-memories.js';
import type { ImportReport } from '../../src/base/memory/agent-memory-report.js';
import { redactSecretsStrict } from '../../src/base/util/secret-detect.js';
import { splitSource, storedItemKey } from '../../src/domain/agent-memories/source.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteImportStores } from '../../src/store/sqlite/agent-import-stores.js';
import {
  agentRows,
  closeWorld,
  liveRows,
  note,
  openWorld,
  projectNotes,
  toolTally,
  withDb,
  type World,
} from '../_helpers/agent-memories-world.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import { pinClock } from '../_helpers/fixed-clock.js';
import { TEST_RUN } from '../_helpers/test-run.js';

pinClock();

const tokenOf = (fill: string): string => runtimeJoin('ghp_', fill.repeat(36));
const TOKEN_A = tokenOf('q');
const TOKEN_B = tokenOf('r');
const BODY = 'Run the schema check before this service deploys.';

let w: World;
beforeEach(() => {
  w = openWorld();
});
afterEach(() => {
  closeWorld(w);
});

const sync = async (): Promise<ImportReport> =>
  importForStore(w.local, {
    run: TEST_RUN,
    configAt: loadConfig,
    tenantId: 'default',
    stores: sqliteImportStores({}),
    machine: w.machine,
  });

function filesHolding(dir: string, token: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && !/hippo\.db/.test(f.name))
    .map((f) => join(f.parentPath, f.name))
    .filter((file) => readFileSync(file).toString('latin1').includes(token));
}

function rawHolders(token: string): number {
  return withDb(w.local, (db) => {
    // SAFETY: the SELECT projects n only.
    const row = db
      .prepare('SELECT count(*) AS n FROM memories WHERE instr(source, ?) > 0 OR instr(content, ?) > 0')
      .get(token, token) as { n: number };
    return row.n;
  });
}

describe('storedItemKey', () => {
  it('is the stored key plus a raw-key hash when redaction changes it, and the stored form leaves it unchanged', () => {
    const key = `deploy-${TOKEN_A}.md`;
    const stored = storedItemKey(key);
    expect(stored).not.toContain(TOKEN_A);
    expect(stored).toMatch(/^deploy-\[REDACTED~[0-9a-f]{12}\]\.md$/);
    expect(redactSecretsStrict(stored)).toBe(stored);
    expect(storedItemKey(stored)).toBe(stored);
    expect(storedItemKey('deploy.md')).toBe('deploy.md');
    expect(storedItemKey(`deploy-${TOKEN_B}.md`)).not.toBe(stored);
  });

  it('reads a raw older key in a source back as the stored key', () => {
    const key = `deploy-${TOKEN_A}.md`;
    expect(splitSource(`pre/${key}#abc`, 'pre/').key).toBe(storedItemKey(key));
  });
});

describe('agent memory sync of a note named with a secret', () => {
  it('two syncs import the note once', async () => {
    note(projectNotes(w), `deploy-${TOKEN_A}.md`, BODY);
    expect(toolTally(await sync(), 'claude-code').imported).toBe(1);
    const [first] = liveRows(w.local);

    expect(toolTally(await sync(), 'claude-code')).toMatchObject({ imported: 0, replaced: 0, unchanged: 1 });
    expect(agentRows(w.local).map((e) => e.id)).toEqual([first!.id]);
    expect(rawHolders(TOKEN_A)).toBe(0);
  });

  it('a raw-key row a sink write rewrote keeps its id over two syncs: no import, no set-aside', async () => {
    note(projectNotes(w), `deploy-${TOKEN_A}.md`, BODY);
    await sync();
    const [row] = liveRows(w.local);
    const raw = `${row!.source.slice(0, row!.source.lastIndexOf('/') + 1)}deploy-${TOKEN_A}.md${row!.source.slice(row!.source.lastIndexOf('#'))}`;
    withDb(w.local, (db) => db.prepare('UPDATE memories SET source = ? WHERE id = ?').run(raw, row!.id));
    writeEntry(w.local, { ...readEntry(w.local, row!.id)!, source: raw, strength: 0.5 });

    for (let i = 0; i < 2; i++) {
      expect(toolTally(await sync(), 'claude-code')).toMatchObject({ imported: 0, setAside: 0, unchanged: 1 });
    }
    expect(liveRows(w.local).map((e) => e.id)).toEqual([row!.id]);
    expect(rawHolders(TOKEN_A)).toBe(0);
  });

  it('a note named with an underscore-glued token is stored with no raw part, in rows or mirrors', async () => {
    note(projectNotes(w), `note_${TOKEN_A}.md`, BODY);
    await sync();
    expect(toolTally(await sync(), 'claude-code')).toMatchObject({ imported: 0, unchanged: 1 });
    expect(liveRows(w.local)).toHaveLength(1);
    expect(rawHolders(TOKEN_A)).toBe(0);
    expect(filesHolding(w.local, TOKEN_A)).toEqual([]);
  });

  it('two headings whose slugs redact alike stay two: a note gone under one is set aside, not superseded', async () => {
    const gl = runtimeJoin('gl', 'pat');
    const memory = join(w.home, '.openclaw', 'workspace', 'MEMORY.md');
    mkdirSync(dirname(memory), { recursive: true });
    writeFileSync(memory, `## ${gl} deployment configuration\n\n- Run the schema check before every deploy.\n`, 'utf8');
    await sync();
    writeFileSync(
      memory,
      `## ${gl} staging authentication\n\n- Use the staging login before the smoke tests.\n`,
      'utf8',
    );
    expect(toolTally(await sync(), 'openclaw')).toMatchObject({ setAside: 1, replaced: 0 });
  });

  it('two notes that differ only in the token keep two identities', async () => {
    const dir = projectNotes(w);
    note(dir, `deploy-${TOKEN_A}.md`, BODY);
    note(dir, `deploy-${TOKEN_B}.md`, `${BODY} Also the staging one.`);
    await sync();
    await sync();
    const sources = liveRows(w.local).map((e) => e.source);
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    expect(rawHolders(TOKEN_A) + rawHolders(TOKEN_B)).toBe(0);
  });
});
