// The row fields `api.remember` and `api.supersede` take from a caller in this process reach the row,
// and a client that sends the same fields over HTTP or MCP changes nothing.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { adminActor, remember, supersede } from '../../src/api/index.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { serve, type ServerHandle } from '../../src/server.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadAllEntries, readEntry } from '../_helpers/root-forms.js';

const NOTE = 'the billing service retries a failed charge three times';
const NEWER = 'the billing service retries a failed charge five times';
// What a client would send to pin a row, pick its layer and source, or start it weak.
const LOCAL = {
  layer: 'semantic',
  pinned: true,
  confidence: 'inferred',
  source: 'import',
  schemaFit: 0.9,
  traceOutcome: 'success',
  sourceSessionId: 'sess-9',
  weaken: { strength: 0.3, halfLifeFactor: 0.5 },
};

let root: string;
let ctx: FullContext;

beforeEach(() => {
  root = makeRoot('local-write-options', { config: { embeddings: { enabled: false }, autoSleep: { enabled: false } } });
  ctx = apiCtx(root, 'default', adminActor('cli'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function row(id: string | null | undefined): MemoryEntry {
  const entry = readEntry(root, id ?? '');
  if (!entry) throw new Error(`no row ${id}`);
  return entry;
}

/** The fields the local group and the supersede overrides can set. */
function settable(entry: MemoryEntry) {
  const { layer, pinned, confidence, source, schemaFit, traceOutcome, sourceSessionId, halfLifeDays, tags } = entry;
  return {
    layer,
    pinned,
    confidence,
    source,
    schemaFit,
    traceOutcome,
    sourceSessionId,
    halfLifeDays,
    tags,
    strength: Number(entry.strength.toFixed(6)),
  };
}

describe('in process', () => {
  it('api.remember stores each field of the local group', async () => {
    const { id } = await remember(ctx, {
      content: NOTE,
      local: {
        layer: Layer.Semantic,
        pinned: true,
        confidence: 'inferred',
        source: 'import',
        schemaFit: 0.9,
        traceOutcome: 'success',
        sourceSessionId: 'sess-9',
      },
    });
    expect(id).toMatch(/^sem_/);
    expect(row(id)).toMatchObject({
      layer: 'semantic',
      pinned: true,
      confidence: 'inferred',
      source: 'import',
      schemaFit: 0.9,
      traceOutcome: 'success',
      sourceSessionId: 'sess-9',
    });
  });

  it('weaken starts the row at its strength and multiplies the half-life, never below one day', async () => {
    const plain = row((await remember(ctx, { content: NOTE })).id);
    const weak = row(
      (await remember(ctx, { content: NEWER, local: { weaken: { strength: 0.3, halfLifeFactor: 0.5 } } })).id,
    );
    const floored = row(
      (await remember(ctx, { content: `${NEWER} again`, local: { weaken: { strength: 0.3, halfLifeFactor: 0.0001 } } }))
        .id,
    );
    expect(weak.strength).toBe(0.3);
    expect(weak.halfLifeDays).toBe(plain.halfLifeDays * 0.5);
    expect(floored.halfLifeDays).toBe(1);
  });

  it("api.supersede overrides replace the old row's layer, tags and pin, and without them the successor keeps all three", async () => {
    const seed = async (content: string) =>
      (await remember(ctx, { content, tags: ['billing'], local: { pinned: true } })).id;
    const kept = row((await supersede(ctx, await seed(NOTE), NEWER)).newId);
    expect(settable(kept)).toMatchObject({ layer: 'episodic', tags: ['billing'], pinned: true });

    const changed = row(
      (
        await supersede(ctx, await seed(`${NOTE} a day`), `${NEWER} a day`, {
          layer: Layer.Semantic,
          tags: ['paging'],
          pinned: false,
        })
      ).newId,
    );
    expect(settable(changed)).toMatchObject({ layer: 'semantic', tags: ['paging'], pinned: false });
  });
});

describe('from a client', () => {
  let handle: ServerHandle;
  let key: string;

  beforeEach(async () => {
    const db = openHippoDb(root);
    try {
      key = createApiKey(db, { tenantId: 'default', role: 'admin' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  async function post(path: string, body: Record<string, JsonValue>): Promise<Record<string, JsonValue>> {
    const res = await fetch(`${handle.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    // SAFETY: every route and the MCP endpoint answer a JSON object.
    return (await res.json()) as Record<string, JsonValue>;
  }

  it('POST /v1/memories stores the same row with a local group in the body as without one', async () => {
    const plain = await post('/v1/memories', { content: NOTE });
    const sent = await post('/v1/memories', { content: NEWER, local: LOCAL });
    expect(settable(row(String(sent['id'])))).toEqual(settable(row(String(plain['id']))));
    expect(row(String(sent['id'])).pinned).toBe(false);
  });

  it('POST /v1/memories/:id/supersede ignores layer, tags and pinned in the body', async () => {
    const old = await post('/v1/memories', { content: NOTE, tags: ['billing'] });
    const body = {
      content: NEWER,
      layer: 'semantic',
      tags: ['paging'],
      pinned: true,
      overrides: { layer: 'semantic', tags: ['paging'], pinned: true },
    };
    const done = await post(`/v1/memories/${String(old['id'])}/supersede`, body);
    expect(settable(row(String(done['newId'])))).toMatchObject({ layer: 'episodic', tags: ['billing'], pinned: false });
  });

  it('hippo_remember stores the same row with a local group in its arguments as without one', async () => {
    const call = (args: Record<string, JsonValue>) =>
      post('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_remember', arguments: args },
      });
    await call({ text: NOTE });
    await call({ text: NEWER, local: LOCAL });
    const stored = (content: string) =>
      settable(loadAllEntries(root, 'default').find((entry) => entry.content === content) ?? row(null));
    expect(stored(NEWER)).toEqual(stored(NOTE));
    expect(stored(NEWER).pinned).toBe(false);
  });
});
