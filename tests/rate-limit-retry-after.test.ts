// A refused caller learns when to come back, and a throttled heartbeat never reads as a revoked key.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { createApiKey } from '../src/store/auth.js';
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

  it('does not drain a bucket when the clock steps back', () => {
    const rl = limiter(20, 40);
    expect(rl.check('a', 86_400_000)).toBe(true);
    expect(rl.check('a', 0)).toBe(true);
    expect(rl.check('a', 50)).toBe(true);
  });

  it('refills the span a stepped-back clock covers once, not again when it comes forward', () => {
    const rl = limiter(1, 2);
    expect([rl.check('a', 10_000), rl.check('a', 10_000)]).toEqual([true, true]);
    expect(rl.check('a', 5_000)).toBe(false);
    expect(rl.check('a', 10_500)).toBe(false);
    expect(rl.check('a', 11_000)).toBe(true);
  });
});

/** Top-level argument texts of the call whose `(` sits at `open`; commas inside strings, templates and brackets do not split. Null when unclosed. */
function callArgs(text: string, open: number): string[] | null {
  const stack: string[] = [')'];
  const args: string[] = [];
  let start = open + 1;
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
      if (stack.length === 0) return [...args, text.slice(start, i).trim()];
    } else if (c === ',' && stack.length === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** Lines where `429` is neither a comment, a status comparison, nor an HttpError given a real Retry-After value. */
function unexplained429s(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b429\b/g)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const before = text.slice(lineStart, m.index);
    if (/^\s*(\*|\/\*)/.test(before) || before.includes('//')) continue;
    if (/[!=]==\s*$/.test(before) || /^\s*[!=]==/.test(text.slice(m.index + 3))) continue;
    const call = /HttpError\(\s*$/.exec(before);
    const args = call ? callArgs(text, lineStart + call.index + 'HttpError'.length) : null;
    if (args?.length === 3 && args[2] !== 'undefined' && args[2] !== 'void 0') continue;
    out.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
  }
  return out;
}

describe('every 429 in core src', () => {
  it('is an HttpError with a Retry-After value, a status comparison, or a comment', () => {
    const files = readdirSync(join(repoRoot, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const texts = files.map((file) => ({ file, text: readFileSync(join(repoRoot, 'src', file), 'utf8') }));
    expect(texts.some(({ text }) => /HttpError\(\s*429\b/.test(text))).toBe(true);
    expect(texts.flatMap(({ file, text }) => unexplained429s(file, text))).toEqual([]);
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
