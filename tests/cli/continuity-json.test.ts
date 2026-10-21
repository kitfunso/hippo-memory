// The port's session rows are camelCase; these pin the snake_case JSON the CLI's --json prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { handleCurrent, handleSession, handleSnapshot } from '../../src/surface/cli/continuity.js';
import type { CliFlags, CommandContext } from '../../src/surface/cli/flag-values.js';
import { appendSessionEvent, saveActiveTaskSnapshot } from '../_helpers/root-forms.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const SNAPSHOT_JSON =
  '{"id":1,"task":"pin the wire","summary":"s","next_step":"n","status":"active","source":"test",' +
  '"session_id":"sess-wire","scope":null,"created_at":"<at>","updated_at":"<at>"}';
const EVENT_JSON =
  '{"id":1,"session_id":"sess-wire","task":null,"event_type":"note","content":"a trail","source":"test",' +
  '"scope":null,"metadata":{"k":1},"created_at":"<at>"}';

let root = '';
const c = (args: string[], flags: CliFlags): CommandContext => ({ hippoRoot: root, tenantId: 'default', args, flags });

/** The printed JSON, key order kept, with each timestamp masked. */
async function printed(run: () => Promise<void>): Promise<string> {
  const { stdout } = await runInProcess(run);
  return JSON.stringify(JSON.parse(stdout)).replace(/"\d{4}-\d{2}-\d{2}[T ][^"]*"/g, '"<at>"');
}

beforeEach(() => {
  root = makeRoot('continuity-json', { config: { embeddings: { enabled: false } } });
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  saveActiveTaskSnapshot(root, 'default', {
    task: 'pin the wire',
    summary: 's',
    nextStep: 'n',
    sessionId: 'sess-wire',
    source: 'test',
  });
  appendSessionEvent(root, 'default', {
    sessionId: 'sess-wire',
    eventType: 'note',
    content: 'a trail',
    source: 'test',
    metadata: { k: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeAfterRequest(root);
});

describe('continuity --json keeps snake_case keys', () => {
  it('snapshot show', async () => {
    expect(await printed(() => handleSnapshot(c(['show'], { json: true })))).toBe(`{"snapshot":${SNAPSHOT_JSON}}`);
  });

  it('session show and session latest', async () => {
    expect(await printed(() => handleSession(c(['show'], { json: true })))).toBe(`{"events":[${EVENT_JSON}]}`);
    expect(await printed(() => handleSession(c(['latest'], { json: true })))).toBe(
      `{"snapshot":${SNAPSHOT_JSON},"events":[${EVENT_JSON}]}`,
    );
  });

  it('current show', async () => {
    expect(await printed(() => handleCurrent(c(['show'], { json: true })))).toBe(
      `{"snapshot":${SNAPSHOT_JSON},"events":[` +
        '{"id":1,"session_id":"sess-wire","event_type":"note","content":"a trail","created_at":"<at>"}]}',
    );
  });
});
