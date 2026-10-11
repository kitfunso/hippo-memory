// `hippo reject` and `hippo invalidate` reach the trust and learn flows through src/api, as HTTP and MCP do.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { adminActor, ForbiddenError, invalidateMemories, rejectOnHost, remember, type HippoDbContext } from '../src/api/index.js';
import { readEntry } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';

let root: string;
const cli = (tenantId = 'default'): HippoDbContext => ({ hippoRoot: root, tenantId, actor: adminActor('cli') });

beforeEach(() => {
  root = makeRoot('cli-curate-api', { config: { embeddings: { enabled: false } } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the CLI curate verbs go through src/api', () => {
  it('curate.ts imports neither the reject flow writer nor the invalidation writer', () => {
    const source = readFileSync(new URL('../src/cli/curate.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\brejectValue\b/);
    expect(source).not.toMatch(/learn\/invalidation/);
  });

  it('rejectOnHost reports every removed row and refuses a caller who is not the host admin', () => {
    const text = 'the nightly export runs at four in the morning';
    const id = remember(cli(), { content: text }).id;
    const result = rejectOnHost(cli(), { memoryId: id, reason: 'wrong time' });
    expect(result).toMatchObject({ content: text, removedIds: [id], successorIds: [], dormantSuccessorIds: [] });
    expect(readEntry(root, id, 'default')).toBeNull();
    const member: HippoDbContext = { hippoRoot: root, tenantId: 'default', actor: { subject: 'api_key:hk_m', role: 'member' } };
    expect(() => rejectOnHost(member, { value: 'anything else', reason: 'x' })).toThrow(ForbiddenError);
  });

  it('rejectOnHost keeps the personal refusal for a personal row by id', () => {
    const owner: HippoDbContext = { hippoRoot: root, tenantId: 'default', actor: { subject: 'api_key:hk_a', role: 'member', owner: 'a' } };
    const id = remember(owner, { content: 'my own reminder about the dentist', personal: true }).id;
    expect(() => rejectOnHost(cli(), { memoryId: id, reason: 'x' })).toThrow("Personal memories can't be rejected. Use forget to remove it.");
  });

  it('invalidateMemories weakens only the context tenant', () => {
    const here = remember(cli(), { content: 'we deploy with jenkins pipelines' }).id;
    const there = remember(cli('other'), { content: 'we deploy with jenkins pipelines' }).id;
    const result = invalidateMemories(cli(), { from: 'jenkins', to: 'github actions', type: 'migration' }, {});
    expect(result.targets).toEqual([here]);
    expect(readEntry(root, here, 'default')?.confidence).toBe('stale');
    expect(readEntry(root, there, 'other')?.confidence).not.toBe('stale');
  });
});
