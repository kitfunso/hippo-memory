// A refused caller learns when to come back, and a throttled heartbeat never reads as a revoked key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { heartbeatVerdict } from '../src/server/auth.js';
import { sqliteStore } from '../src/store-port.js';
import { makeRoot } from './_helpers/make-root.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const limiter = (ratePerSec: number, burst = 1) => createRateLimiter({ ratePerSec, burst, idleEvictMs: 60000, maxKeys: 10 });

describe('createRateLimiter', () => {
  it.each([[20, 1], [1, 1], [0.5, 2], [0.3, 4], [0.1, 10]])('at %s a second sends Retry-After %s', (ratePerSec, seconds) => {
    expect(limiter(ratePerSec).retryAfterSec).toBe(seconds);
  });

  it('hasToken spends nothing and sees the refill', () => {
    const rl = limiter(10, 2);
    expect([rl.hasToken('a', 1000), rl.hasToken('a', 1000)]).toEqual([true, true]);
    expect([rl.check('a', 1000), rl.check('a', 1000)]).toEqual([true, true]);
    expect(rl.hasToken('a', 1000)).toBe(false);
    expect(rl.hasToken('a', 1100)).toBe(true);
    expect([rl.check('a', 1100), rl.check('a', 1100)]).toEqual([true, false]);
  });

  it('does not drain a bucket when the clock steps back', () => {
    const rl = limiter(20, 40);
    expect(rl.check('a', 86_400_000)).toBe(true);
    expect(rl.hasToken('a', 0)).toBe(true);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.hasToken('a', 50)).toBe(true);
  });
});

/** Top-level argument count of the call whose `(` sits at `open`; commas inside strings, templates and brackets do not count. -1 when unclosed. */
function argCount(text: string, open: number): number {
  const stack: string[] = [')'];
  let commas = 0;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === '`' || top === "'" || top === '"') {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
      else if (top === '`' && c === '$' && text[i + 1] === '{') { stack.push('}'); i++; }
      continue;
    }
    if (c === '`' || c === "'" || c === '"') stack.push(c);
    else if (c === '(') stack.push(')');
    else if (c === '[') stack.push(']');
    else if (c === '{') stack.push('}');
    else if (c === top) {
      stack.pop();
      if (stack.length === 0) return commas + 1;
    } else if (c === ',' && stack.length === 1) commas++;
  }
  return -1;
}

describe('every 429 in core src', () => {
  it('passes HttpError a Retry-After value', () => {
    const sites: Array<{ at: string; args: number }> = [];
    const files = readdirSync(join(repoRoot, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const text = readFileSync(join(repoRoot, 'src', file), 'utf8');
      for (const m of text.matchAll(/HttpError\(\s*429\b/g)) {
        sites.push({ at: `${file}:${text.slice(0, m.index).split('\n').length}`, args: argCount(text, m.index + m[0].indexOf('(')) });
      }
    }
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((s) => s.args < 3)).toEqual([]);
  });

  it('argCount reads a template with a nested call as one argument', () => {
    const text = 'new HttpError(429, `limit ${f(a, b)}); x`, 60)';
    expect(argCount(text, text.indexOf('('))).toBe(3);
    expect(argCount('HttpError(429, "a, b")', 9)).toBe(2);
  });
});

describe('heartbeatVerdict', () => {
  const saved = process.env.HIPPO_CLIENT_IP_HEADER;
  let root: string;

  beforeEach(() => {
    delete process.env.HIPPO_CLIENT_IP_HEADER;
    root = makeRoot('heartbeat-429');
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.HIPPO_CLIENT_IP_HEADER;
    else process.env.HIPPO_CLIENT_IP_HEADER = saved;
    rmSync(root, { recursive: true, force: true });
  });

  function streamReq(token: string, remoteAddress: string): IncomingMessage {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
    const req = new IncomingMessage(socket);
    req.headers.authorization = `Bearer ${token}`;
    return req;
  }

  it('skips a tick on a failed-auth 429 instead of closing the stream; a wrong secret still revokes', async () => {
    const db = openHippoDb(root);
    const plaintext = (() => {
      try {
        return createApiKey(db, { tenantId: 'default', role: 'member' }).plaintext;
      } finally {
        closeHippoDb(db);
      }
    })();
    const failedAuth = limiter(0.1);
    failedAuth.check('203.0.113.9');
    const opts = { hippoRoot: root, store: sqliteStore(root), failedAuthLimiter: failedAuth };
    expect(await heartbeatVerdict(streamReq(plaintext, '203.0.113.9'), opts)).toBe('unavailable');
    const wrong = `${plaintext.slice(0, plaintext.indexOf('.'))}.${'a'.repeat(32)}`;
    expect(await heartbeatVerdict(streamReq(wrong, '198.51.100.1'), opts)).toBe('revoked');
  });
});
