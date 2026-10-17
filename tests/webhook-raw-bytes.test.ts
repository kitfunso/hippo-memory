// The webhook HMAC covers the bytes the sender signed, so a body that is not valid UTF-8 verifies on its own bytes and
// on no other text.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const SECRET = 'raw-bytes-secret';
// 0xff and 0xfe never occur in UTF-8, so decoding turns each into U+FFFD.
const BODY = Buffer.concat([Buffer.from('{"action":"opened","note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
const DECODED_AND_REENCODED = Buffer.from(BODY.toString('utf8'), 'utf8');

const hmac = (payload: readonly (string | Buffer)[]): string => {
  const mac = createHmac('sha256', SECRET);
  for (const part of payload) mac.update(part);
  return mac.digest('hex');
};

let handle: ServerHandle;

beforeEach(async () => {
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  handle = await serve({ hippoRoot: makeRoot('webhook-bytes'), host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  await handle.stop();
});

function postSlack(signedOver: Buffer): Promise<Response> {
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${handle.url}/v1/connectors/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': `v0=${hmac([`v0:${ts}:`, signedOver])}`,
    },
    body: BODY,
  });
}

function postGitHub(signedOver: Buffer, deliveryId: string): Promise<Response> {
  return fetch(`${handle.url}/v1/connectors/github/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${hmac([signedOver])}`,
      'x-github-event': 'issues',
      'x-github-delivery': deliveryId,
    },
    body: BODY,
  });
}

describe('a webhook body that is not valid UTF-8', () => {
  it('Slack accepts the signature over its bytes', async () => {
    expect((await postSlack(BODY)).status).toBe(200);
  });

  it('Slack refuses a signature over its decoded text', async () => {
    expect((await postSlack(DECODED_AND_REENCODED)).status).toBe(401);
  });

  it('GitHub accepts the signature over its bytes', async () => {
    expect((await postGitHub(BODY, 'raw-bytes-1')).status).toBe(200);
  });

  it('GitHub refuses a signature over its decoded text', async () => {
    expect((await postGitHub(DECODED_AND_REENCODED, 'raw-bytes-2')).status).toBe(401);
  });
});
