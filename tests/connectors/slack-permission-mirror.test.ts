import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { ingestMessage } from '../../src/connectors/slack/ingest.js';
import { retrieve } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

const ctx = (root: string): FullContext => (apiCtx(root, 'default', { subject: 'connector:slack', role: 'admin' }));

describe('slack permission mirroring', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('slack-perm');
  });

  it('private-channel content does not leak when querying public scope', async () => {
    await ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPUB', is_private: false },
      message: { type: 'message', channel: 'CPUB', user: 'U1', text: 'public secret', ts: '1.1' },
      eventId: 'EvPub',
    });
    await ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPRIV', is_private: true },
      message: { type: 'message', channel: 'CPRIV', user: 'U1', text: 'private secret', ts: '2.2' },
      eventId: 'EvPriv',
    });

    const pubResults = await retrieve(ctx(root), { query: 'secret', filter: { scope: 'slack:public:CPUB' } });
    expect(pubResults.results.some((r) => r.content.includes('private secret'))).toBe(false);
    expect(pubResults.results.some((r) => r.content.includes('public secret'))).toBe(true);
  });

  // Review patch #4: empty/undefined scope must default-deny private rows.
  // Without this guarantee, a frontend caller forgetting to pass `scope` exposes
  // every private channel to a public query.
  it('no-scope query default-denies private rows', async () => {
    await ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPUB', is_private: false },
      message: { type: 'message', channel: 'CPUB', user: 'U1', text: 'public alpha', ts: '1.1' },
      eventId: 'EvPubA',
    });
    await ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPRIV', is_private: true },
      message: { type: 'message', channel: 'CPRIV', user: 'U1', text: 'private alpha', ts: '2.2' },
      eventId: 'EvPrivA',
    });
    const r = await retrieve(ctx(root), { query: 'alpha' }); // no scope
    expect(r.results.some((x) => x.content.includes('private alpha'))).toBe(false);
    expect(r.results.some((x) => x.content.includes('public alpha'))).toBe(true);
  });

  // Review patch #4: mismatched scope (channel does not exist) returns zero.
  it('mismatched scope returns zero results', async () => {
    await ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPUB', is_private: false },
      message: { type: 'message', channel: 'CPUB', user: 'U1', text: 'beta', ts: '1.1' },
      eventId: 'EvPubB',
    });
    const r = await retrieve(ctx(root), { query: 'beta', filter: { scope: 'slack:public:CDOES_NOT_EXIST' } });
    expect(r.results).toHaveLength(0);
  });

  // Review patch #4: tenant-mismatched scope. Tenant B writes a private row
  // with scope='slack:private:CSHARED'. Tenant A queries the same scope string
  // and must get nothing — recall is tenant-scoped before scope-scoped.
  it('tenant-mismatched scope does not leak across tenants', async () => {
    const ctxA = (r: string): FullContext => (apiCtx(r, 'tenantA', { subject: 'cli', role: 'admin' }));
    const ctxB = (r: string): FullContext => (apiCtx(r, 'tenantB', { subject: 'cli', role: 'admin' }));
    await ingestMessage(ctxB(root), {
      teamId: 'T1',
      channel: { id: 'CSHARED', is_private: true },
      message: { type: 'message', channel: 'CSHARED', user: 'U1', text: 'tenantB secret', ts: '3.3' },
      eventId: 'EvShared',
    });
    const r = await retrieve(ctxA(root), { query: 'secret', filter: { scope: 'slack:private:CSHARED' } });
    expect(r.results).toHaveLength(0);
  });
});
