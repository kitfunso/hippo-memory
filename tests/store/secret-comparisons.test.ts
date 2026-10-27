// A lookup or same-text check with caller text matches both the redacted row a write stores and a raw legacy row written before the boundary.
import { beforeEach, describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { adminActor } from '../../src/api/index.js';
import { CLI_LEARN, learn, MCP_LEARN, type LearnProfile } from '../../src/api/sleep/learn.js';
import type { GitRunner } from '../../src/base/ports/git.js';
import { CONTENT_CAP, storedText } from '../../src/domain/agent-memories/source.js';
import { renameEntrySource } from '../../src/store/sqlite/entry-writes.js';
import { listTextKeysHolding } from '../../src/store/sqlite/copy-rows.js';
import { graphDeltaOn } from '../../src/store/sqlite/graph-delta.js';
import { insertEntityRow, updateEntityRow } from '../../src/store/sqlite/graph-writes.js';
import { listSessionEvents } from '../../src/store/sqlite/sessions.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { cliSave } from '../_helpers/cli-save-site.js';
import { CUSTOMER_NOTE } from '../../src/domain/objects/customer-notes.js';
import { POLICY } from '../../src/domain/objects/policies.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, readEntry } from '../_helpers/root-forms.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

const GHP = runtimeJoin('ghp_', 'Rt5', 'k'.repeat(30), 'W2e');
const T = 'default';
const NOW = '2026-10-01T00:00:00.000Z';

let root: string;
beforeEach(() => {
  root = makeRoot('secret-comparisons');
});

function withDb<R>(fn: (db: DatabaseSyncLike) => R): R {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Sets a column back to the raw text a release before the boundary stored. */
function makeLegacy(table: string, column: string, raw: string, where: string, id: string | number): void {
  withDb((db) => db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where} = ?`).run(raw, id));
}

async function writeMemory(content: string, source = 'cli'): Promise<string> {
  const entry = createMemory(content, { source });
  await sqliteStore(root).entryWrites.writeEntry({ entry, actor: 'tester' });
  return entry.id;
}

describe('lookups by caller text', () => {
  it('a task-filtered event read finds the event whose task held a secret', async () => {
    const task = `rotate ${GHP}`;
    await sqliteStore(root).sessions.save(T, 'event', { sessionId: 's1', eventType: 'note', task, content: 'done' });
    const found = withDb((db) => listSessionEvents(db, T, { task }));
    expect(found.map((e) => e.content)).toEqual(['done']);
  });

  it('--entity finds an entity by its raw name, stored or legacy', async () => {
    const name = `vault ${GHP}`;
    const memoryId = await writeMemory('the vault rotates keys');
    const stored = withDb((db) => insertEntityRow(db, T, { entityType: 'system', name, memoryId }));
    const legacy = withDb((db) => insertEntityRow(db, T, { entityType: 'system', name: 'other', memoryId }));
    makeLegacy('entities', 'name', name, 'id', legacy.id);
    const found = await sqliteStore(root).graphReads.graphRows(T, { entity: name, limit: 10 });
    expect(found.entities.map((e) => e.id).sort()).toEqual([stored.id, legacy.id].sort());
  });

  it('a customer filter and a policy name find the object by its raw text', async () => {
    const customer = `acme ${GHP}`;
    await cliSave(root, T, CUSTOMER_NOTE, { customer, note: 'renewal in March' });
    const notes = await sqliteStore(root).objects.listObjects(T, 'customer_note', { filter: customer, limit: 10 });
    expect(notes.map((n) => n.note)).toEqual(['renewal in March']);
    const policyName = `retry ${GHP}`;
    await cliSave(root, T, POLICY, { policyName, policyText: 'three times' });
    const asOf = new Date().toISOString();
    const inForce = await sqliteStore(root).objects.listObjects(T, 'policy', { asOf, name: policyName, limit: 10 });
    expect(inForce.map((p) => p.policyText)).toEqual(['three times']);
  });

  it('a source rename moves a legacy row that holds the old source raw', async () => {
    const from = `notes ${GHP}`;
    const id = await writeMemory('the deploy runs on tuesdays', from);
    makeLegacy('memories', 'source', from, 'id', id);
    expect(withDb((db) => renameEntrySource(db, { tenantId: T, id, from, to: 'notes' }))).toBe(1);
    expect(readEntry(root, id)?.source).toBe('notes');
  });

  it('a copy probe with raw text finds the stored row and a raw legacy twin', async () => {
    const text = `the ci token is ${GHP}`;
    const stored = await writeMemory(text);
    const legacy = await writeMemory('placeholder text for a legacy row');
    makeLegacy('memories', 'content', text, 'id', legacy);
    withDb((db) => {
      db.prepare('DELETE FROM memories_fts WHERE id = ?').run(legacy);
      db.prepare('INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)').run(legacy, text, '');
    });
    const held = withDb((db) => listTextKeysHolding(db, { tenantId: T }, [text]));
    expect(held.map((r) => r.id).sort()).toEqual([stored, legacy].sort());
  });
});

describe('same-text checks', () => {
  it('a second learn run skips a lesson that held a JWT, and the full scan skips a raw legacy twin', async () => {
    const jwt = runtimeJoin('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'c2lnbmF0dXJlLXNpZw');
    const git: GitRunner = {
      run: (args) => ({ ok: true, stdout: args[0] === 'rev-parse' ? 'true' : `fix: rotate the deploy token ${jwt}` }),
    };
    const ctx = apiCtx(root, T, adminActor('learn-test'));
    const run = (profile: LearnProfile) => learn(ctx, { repoPath: root, days: 7, profile, git });
    expect(await run(MCP_LEARN)).toMatchObject({ added: 1, skipped: 0 });
    expect(await run(MCP_LEARN)).toMatchObject({ added: 0, skipped: 1 });
    const row = loadAllEntries(root, T).find((e) => e.source === MCP_LEARN.source)!;
    makeLegacy('memories', 'content', row.content.replace('[REDACTED]', jwt), 'id', row.id);
    expect(await run(CLI_LEARN)).toMatchObject({ added: 0, skipped: 1 });
  });

  it('a graph pass over a legacy entity name rewrites it once, then queues nothing', () => {
    const name = `billing ${GHP}`;
    withDb((db) => {
      const run = db
        .prepare(`INSERT INTO decisions (tenant_id, decision_text, status, created_at) VALUES (?, 'd', 'active', ?)`)
        .run(T, NOW);
      const sourceObject = { type: 'decision' as const, id: Number(run.lastInsertRowid) };
      const entity = insertEntityRow(db, T, { entityType: 'decision', name, sourceObject });
      db.prepare('UPDATE entities SET name = ? WHERE id = ?').run(name, entity.id);
      const desired = {
        entities: [{ entityType: 'decision' as const, name, memoryId: null, sourceObject }],
        relations: [],
      };
      expect(graphDeltaOn(db, T, desired).map((op) => op.op)).toEqual(['updateEntity']);
      updateEntityRow(db, T, entity.id, { name });
      expect(graphDeltaOn(db, T, desired)).toEqual([]);
    });
  });

  it('an agent note with a token across the cap is stored with no half of the token', () => {
    const token = GHP;
    const text = `${'a'.repeat(CONTENT_CAP - 20)} ${token} ${'b'.repeat(40)}`;
    const stored = storedText(text);
    expect(stored).not.toContain(token.slice(0, 12));
    expect(stored.endsWith(' [truncated]')).toBe(true);
  });
});
