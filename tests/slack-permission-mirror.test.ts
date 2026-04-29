import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { recall } from '../src/api.js';

const ctx = (root: string) => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: 'connector:slack',
});

describe('slack permission mirroring', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-perm-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('private-channel content does not leak when querying public scope', () => {
    ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPUB', is_private: false },
      message: { type: 'message', channel: 'CPUB', user: 'U1', text: 'public secret', ts: '1.1' },
      eventId: 'EvPub',
    });
    ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPRIV', is_private: true },
      message: { type: 'message', channel: 'CPRIV', user: 'U1', text: 'private secret', ts: '2.2' },
      eventId: 'EvPriv',
    });

    const pubResults = recall(ctx(root), { query: 'secret', scope: 'slack:public:CPUB' });
    expect(pubResults.results.some((r) => r.content.includes('private secret'))).toBe(false);
    expect(pubResults.results.some((r) => r.content.includes('public secret'))).toBe(true);
  });

  // Review patch #4: empty/undefined scope must default-deny private rows.
  // Without this guarantee, a frontend caller forgetting to pass `scope` exposes
  // every private channel to a public query.
  it('no-scope query default-denies private rows', () => {
    ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPUB', is_private: false },
      message: { type: 'message', channel: 'CPUB', user: 'U1', text: 'public alpha', ts: '1.1' },
      eventId: 'EvPubA',
    });
    ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPRIV', is_private: true },
      message: { type: 'message', channel: 'CPRIV', user: 'U1', text: 'private alpha', ts: '2.2' },
      eventId: 'EvPrivA',
    });
    const r = recall(ctx(root), { query: 'alpha' }); // no scope
    expect(r.results.some((x) => x.content.includes('private alpha'))).toBe(false);
    expect(r.results.some((x) => x.content.includes('public alpha'))).toBe(true);
  });

  // Review patch #4: mismatched scope (channel does not exist) returns zero.
  it('mismatched scope returns zero results', () => {
    ingestMessage(ctx(root), {
      teamId: 'T1',
      channel: { id: 'CPUB', is_private: false },
      message: { type: 'message', channel: 'CPUB', user: 'U1', text: 'beta', ts: '1.1' },
      eventId: 'EvPubB',
    });
    const r = recall(ctx(root), { query: 'beta', scope: 'slack:public:CDOES_NOT_EXIST' });
    expect(r.results).toHaveLength(0);
  });

  // Review patch #4: tenant-mismatched scope. Tenant B writes a private row
  // with scope='slack:private:CSHARED'. Tenant A queries the same scope string
  // and must get nothing — recall is tenant-scoped before scope-scoped.
  it('tenant-mismatched scope does not leak across tenants', () => {
    const ctxA = (r: string) => ({ hippoRoot: r, tenantId: 'tenantA', actor: 'cli' });
    const ctxB = (r: string) => ({ hippoRoot: r, tenantId: 'tenantB', actor: 'cli' });
    ingestMessage(ctxB(root), {
      teamId: 'T1',
      channel: { id: 'CSHARED', is_private: true },
      message: { type: 'message', channel: 'CSHARED', user: 'U1', text: 'tenantB secret', ts: '3.3' },
      eventId: 'EvShared',
    });
    const r = recall(ctxA(root), { query: 'secret', scope: 'slack:private:CSHARED' });
    expect(r.results).toHaveLength(0);
  });
});
