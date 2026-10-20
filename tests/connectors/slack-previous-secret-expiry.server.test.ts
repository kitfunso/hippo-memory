// The previous Slack signing secret works until the date the operator names, then it is refused with one warning.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { previousSecretInForce } from '../../src/surface/connectors/slack/signature.js';
import { makeRoot } from '../_helpers/make-root.js';
import { onceKeysPerCase } from '../_helpers/once-keys-per-case.js';

const NEW_SECRET = 'rotated-in';
const OLD_SECRET = 'rotated-out';
const BODY = '{"type":"not_an_envelope"}';
const UNTIL = '2026-12-01';
const BEFORE = Date.parse('2026-11-30T23:59:59Z');
const AT = Date.parse('2026-12-01T00:00:00Z');

let stderr: MockInstance<typeof process.stderr.write>;
const warnings = (): string[] =>
  stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('SLACK_SIGNING_SECRET_PREVIOUS'));

beforeEach(() => {
  onceKeysPerCase();
  vi.stubEnv('HIPPO_LOG', 'warn');
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('previousSecretInForce', () => {
  it('keeps the secret with no end date, or before the date, and drops it from the date on', () => {
    expect(previousSecretInForce(OLD_SECRET, undefined, AT)).toBe(OLD_SECRET);
    expect(previousSecretInForce(OLD_SECRET, '', AT)).toBe(OLD_SECRET);
    expect(previousSecretInForce(OLD_SECRET, UNTIL, BEFORE)).toBe(OLD_SECRET);
    expect(previousSecretInForce(OLD_SECRET, UNTIL, AT)).toBeUndefined();
    expect(previousSecretInForce(OLD_SECRET, '2026-12-01T09:00:00+09:00', AT)).toBeUndefined();
    expect(previousSecretInForce(OLD_SECRET, '2026-12-01T09:00:00+09:00', AT - 1)).toBe(OLD_SECRET);
  });

  it('returns nothing when no previous secret is set, and warns about nothing', () => {
    expect(previousSecretInForce(undefined, UNTIL, AT)).toBeUndefined();
    expect(previousSecretInForce('', UNTIL, AT)).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it.each(['soon', '12/01/2026', '2026-02-31', '2026-12-01 00:00', '20261201'])(
    'refuses the secret when the end date is %s, which is no ISO date',
    (until) => {
      expect(previousSecretInForce(OLD_SECRET, until, BEFORE)).toBeUndefined();
      expect(warnings().join('')).toContain('is not an ISO date');
    },
  );

  it('warns once however many requests meet the closed window', () => {
    for (let i = 0; i < 5; i++) previousSecretInForce(OLD_SECRET, UNTIL, AT + i);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(`expired at ${UNTIL}`);
  });
});

describe('POST /v1/connectors/slack/events with a previous secret', () => {
  let handle: ServerHandle;

  beforeEach(() => {
    vi.stubEnv('SLACK_SIGNING_SECRET', NEW_SECRET);
    vi.stubEnv('SLACK_SIGNING_SECRET_PREVIOUS', OLD_SECRET);
  });

  afterEach(async () => {
    await handle.stop();
  });

  async function postSignedWithOld(): Promise<number> {
    handle = await serve({ hippoRoot: makeRoot('slack-previous'), host: '127.0.0.1', port: 0 });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', OLD_SECRET).update(`v0:${ts}:${BODY}`).digest('hex')}`;
    const res = await fetch(`${handle.url}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': signature },
      body: BODY,
    });
    return res.status;
  }

  it('takes a request signed with the old secret before the end date, and with no end date', async () => {
    vi.stubEnv('SLACK_SIGNING_SECRET_PREVIOUS_UNTIL', '2999-01-01');
    expect(await postSignedWithOld()).toBe(200);
  });

  it('refuses a request signed with the old secret once the end date has passed', async () => {
    vi.stubEnv('SLACK_SIGNING_SECRET_PREVIOUS_UNTIL', '2020-01-01');
    expect(await postSignedWithOld()).toBe(401);
    expect(warnings()).toHaveLength(1);
  });
});
