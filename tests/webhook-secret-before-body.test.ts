// The two webhook routes take no API key, so they must refuse before buffering a body and must not wait on one forever.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const ENV_KEYS = ['SLACK_SIGNING_SECRET', 'SLACK_SIGNING_SECRET_PREVIOUS', 'GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET_PREVIOUS'] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

// Test-only signing material, not a real secret.
const TEST_SECRET = 'test-only-webhook-signing-material';
// Far below the deadline a healthy reply needs, far above the body deadline the server runs with here.
const REPLY_WITHIN_MS = 4000;
const BODY_DEADLINE_MS = 150;

interface Hook {
  name: string;
  path: string;
  secretEnv: (typeof ENV_KEYS)[number];
  /** Headers that pass the presence check; the body never arrives, so their values are never verified. */
  signatureHeaders: Record<string, string>;
  signedPing: () => { body: string; headers: Record<string, string> };
}

const HOOKS: readonly Hook[] = [
  {
    name: 'Slack',
    path: '/v1/connectors/slack/events',
    secretEnv: 'SLACK_SIGNING_SECRET',
    signatureHeaders: { 'x-slack-signature': 'v0=00', 'x-slack-request-timestamp': '1' },
    signedPing: () => {
      const body = '{ "type": "url_verification",\t"challenge": "abc" }';
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', TEST_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
      return { body, headers: { 'x-slack-signature': signature, 'x-slack-request-timestamp': ts } };
    },
  },
  {
    name: 'GitHub',
    path: '/v1/connectors/github/events',
    secretEnv: 'GITHUB_WEBHOOK_SECRET',
    signatureHeaders: { 'x-hub-signature-256': 'sha256=00' },
    signedPing: () => {
      const body = '{ "zen": "keep it logically awesome",\t"hook_id": 1 }';
      const signature = `sha256=${createHmac('sha256', TEST_SECRET).update(body).digest('hex')}`;
      return { body, headers: { 'x-hub-signature-256': signature, 'x-github-event': 'ping', 'x-github-delivery': 'd-1' } };
    },
  },
];

let root: string;
let handle: ServerHandle;
const openRequests: Array<() => void> = [];

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  root = makeRoot('webhook-order');
  handle = await serve({ hippoRoot: root, port: 0, webhookBodyDeadlineMs: BODY_DEADLINE_MS, shutdownDrainMs: 200 });
});

afterEach(async () => {
  for (const abort of openRequests.splice(0)) abort();
  await handle.stop();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Sends the headers and the first bytes of a body, then stops sending; resolves with the status once the server has also closed the socket. */
function statusOfStalledPost(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: handle.port, path, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': '4096', ...headers },
    });
    openRequests.push(() => req.destroy());
    let status: number | undefined;
    const timer = setTimeout(() => reject(new Error(
      status === undefined
        ? `no reply within ${REPLY_WITHIN_MS} ms: the server is waiting for the body`
        : `status ${status}, but the socket is still open ${REPLY_WITHIN_MS} ms on: a refused caller can keep sending`,
    )), REPLY_WITHIN_MS);
    req.on('response', (res) => {
      status = res.statusCode ?? 0;
      res.resume();
    });
    // The half-sent request ends in a socket error once the server closes; with a status in hand that is the expected close.
    req.on('error', (err) => {
      if (status === undefined) {
        clearTimeout(timer);
        reject(err);
      }
    });
    req.on('close', () => {
      clearTimeout(timer);
      if (status !== undefined) resolve(status);
    });
    req.write('{"partial":');
  });
}

describe.each(HOOKS)('$name webhook', (hook) => {
  it('answers 404 without reading a body, and closes, when no signing secret is configured', async () => {
    expect(await statusOfStalledPost(hook.path, hook.signatureHeaders)).toBe(404);
  });

  it('answers 401 without reading a body, and closes, when the signature headers are missing', async () => {
    process.env[hook.secretEnv] = TEST_SECRET;
    expect(await statusOfStalledPost(hook.path, {})).toBe(401);
  });

  it('answers 408, and closes, when a request with signature headers never finishes its body', async () => {
    process.env[hook.secretEnv] = TEST_SECRET;
    expect(await statusOfStalledPost(hook.path, hook.signatureHeaders)).toBe(408);
  });

  it('still verifies the signature over the exact bytes sent', async () => {
    process.env[hook.secretEnv] = TEST_SECRET;
    const { body, headers } = hook.signedPing();
    const post = (text: string): Promise<Response> =>
      fetch(`${handle.url}${hook.path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text });
    expect((await post(body)).status).toBe(200);
    // The same JSON with one tab turned into a space is a different byte string, so the signature no longer fits.
    expect((await post(body.replace('\t', ' '))).status).toBe(401);
  });
});
