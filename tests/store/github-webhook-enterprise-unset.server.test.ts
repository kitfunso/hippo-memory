import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { log } from '../../src/base/util/log.js';

const SECRET = 'github-webhook-secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

function issueBody(number: number): string {
  return JSON.stringify({
    action: 'opened',
    issue: { number, title: 'Bug', body: 'broken', user: { login: 'alice', id: 1 } },
    repository: { full_name: 'acme/repo', private: false, owner: { login: 'acme' }, name: 'repo' },
    sender: { login: 'alice', id: 1 },
    installation: { id: 99 },
  });
}

describe('a GHES delivery while GITHUB_ENTERPRISE_URL is unset', () => {
  let handle: ServerHandle;

  beforeEach(async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    handle = await serve({ hippoRoot: makeRoot('gh-ghes-unset'), host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  it('two deliveries give one warning that its keys carry no host', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      for (const n of [51, 52]) {
        const body = issueBody(n);
        const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/github/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
            'x-github-event': 'issues',
            'x-github-delivery': `d-${n}`,
            'x-github-enterprise-host': 'ghes.example.com',
          },
          body,
        });
        expect(res.status).toBe(200);
      }
      const unset = warn.mock.calls.filter(([m]) => String(m).includes('GITHUB_ENTERPRISE_URL is unset'));
      expect(unset).toHaveLength(1);
      expect(String(unset[0]?.[0])).toContain('ghes.example.com');
    } finally {
      warn.mockRestore();
    }
  });
});
