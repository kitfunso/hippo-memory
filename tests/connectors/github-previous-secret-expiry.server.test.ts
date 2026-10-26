// The previous GitHub webhook secret follows Slack's rule: it works until GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL, and
// either connector's previous secret left with no end date gets one warning when the server starts.
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { onceKeysPerCase } from '../_helpers/once-keys-per-case.js';

const PING = '{"zen":"keep it logically awesome"}';

let stderr: MockInstance<typeof process.stderr.write>;
let handle: ServerHandle | undefined;
const warnings = (name: string): string[] =>
  stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(name));
const secret = (): string => randomBytes(16).toString('hex');

beforeEach(() => {
  onceKeysPerCase();
  vi.stubEnv('HIPPO_LOG', 'warn');
  for (const name of ['SLACK_SIGNING_SECRET', 'SLACK_SIGNING_SECRET_PREVIOUS', 'SLACK_SIGNING_SECRET_PREVIOUS_UNTIL']) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL', undefined);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A fresh server, so each start reads the environment as it stands; the last one stops first. */
async function start(): Promise<string> {
  await handle?.stop();
  handle = await serve({ hippoRoot: makeRoot('gh-previous'), host: '127.0.0.1', port: 0 });
  return handle.url;
}

describe('POST /v1/connectors/github/events with a previous secret', () => {
  let old = '';

  beforeEach(() => {
    old = secret();
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', secret());
    vi.stubEnv('GITHUB_WEBHOOK_SECRET_PREVIOUS', old);
  });

  async function pingSignedWithOld(): Promise<number> {
    const url = await start();
    const res = await fetch(`${url}/v1/connectors/github/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', old).update(PING).digest('hex')}`,
        'x-github-event': 'ping',
        'x-github-delivery': 'd-previous',
      },
      body: PING,
    });
    await res.arrayBuffer();
    return res.status;
  }

  it('takes a delivery signed with the old secret before the end date, and with none set', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL', '2999-01-01');
    expect(await pingSignedWithOld()).toBe(200);
    vi.stubEnv('GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL', undefined);
    expect(await pingSignedWithOld()).toBe(200);
  });

  it('refuses a delivery signed with the old secret from the end date on, with one warning', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL', '2020-01-01');
    expect([await pingSignedWithOld(), await pingSignedWithOld()]).toEqual([401, 401]);
    expect(warnings('GITHUB_WEBHOOK_SECRET_PREVIOUS expired at 2020-01-01')).toHaveLength(1);
  });
});

describe('the start-up warning for a previous secret with no end date', () => {
  it.each([
    ['SLACK_SIGNING_SECRET_PREVIOUS', 'SLACK_SIGNING_SECRET_PREVIOUS_UNTIL'],
    ['GITHUB_WEBHOOK_SECRET_PREVIOUS', 'GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL'],
  ])('names %s and %s once, and stays quiet once the end date is set', async (name, until) => {
    vi.stubEnv(name, secret());
    await start();
    await start();
    expect(warnings(`${name} is set with no ${until}`)).toHaveLength(1);

    stderr.mockClear();
    onceKeysPerCase();
    vi.stubEnv(until, '2999-01-01');
    await start();
    expect(warnings(name)).toEqual([]);
  });

  it('says nothing when neither connector has a previous secret', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET_PREVIOUS', undefined);
    await start();
    expect(warnings('_PREVIOUS')).toEqual([]);
  });
});
