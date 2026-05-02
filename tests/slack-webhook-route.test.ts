import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore, loadAllEntries } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { buildProvenanceCoverage } from '../src/provenance-coverage.js';

const SECRET = 'shhh';

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

describe('POST /v1/connectors/slack/events', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-route-'));
    initStore(root);
    process.env.SLACK_SIGNING_SECRET = SECRET;
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('echoes the URL verification challenge', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge?: string };
    expect(json.challenge).toBe('abc123');
  });

  it('rejects missing/invalid signature with 401', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T',
      event_id: 'E',
      event_time: 0,
      event: { type: 'message', channel: 'C1', ts: '1.1', text: 'hi' },
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('writes a memory on a valid event_callback', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvA',
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel: 'C1',
        channel_type: 'channel',
        user: 'U1',
        text: 'hello',
        ts: '1700000000.000100',
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root);
    const slackRow = entries.find((e) => e.tags.includes('source:slack') && e.kind === 'raw');
    expect(slackRow).toBeDefined();
    expect(slackRow!.owner).toBe('user:U1');
    expect(slackRow!.artifact_ref).toBe('slack://T1/C1/1700000000.000100');

    const coverage = buildProvenanceCoverage(entries);
    expect(coverage.rawTotal).toBe(1);
    expect(coverage.coverage).toBe(1);
    expect(coverage.gaps).toEqual([]);
  });

  it('writes malformed payloads to DLQ but still ACKs 200', async () => {
    const body = '{"type":"event_callback","event":{}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const db = openHippoDb(root);
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM slack_dlq`).get() as { c: number };
      expect(Number(row.c)).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('returns 404 when SLACK_SIGNING_SECRET is unset (no config leak)', async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    try {
      const body = '{}';
      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status).toBe(404);
    } finally {
      process.env.SLACK_SIGNING_SECRET = SECRET;
    }
  });

  it('accepts valid signature with no Bearer (PUBLIC_ROUTES allow-list)', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EvNoBearer',
      event_time: Math.floor(Date.now() / 1000),
      event: {
        type: 'message',
        channel: 'C1',
        channel_type: 'channel',
        user: 'U1',
        text: 'no-bearer ok',
        ts: '1700000001.000200',
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, body),
      },
      body,
    });
    expect(res.status).toBe(200);
  });
});
