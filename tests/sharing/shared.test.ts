import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { copyToGlobal, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpStore(): string {
  const dir = makeRoot('test');
  return dir;
}

function cleanUp(...dirs: string[]): void {
  for (const d of dirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// getGlobalRoot
// ---------------------------------------------------------------------------

describe('getGlobalRoot', () => {
  it('falls back to ~/.hippo when neither env var is set', () => {
    vi.stubEnv('HIPPO_HOME', undefined);
    vi.stubEnv('XDG_DATA_HOME', undefined);
    expect(getGlobalRoot()).toBe(path.join(os.homedir(), '.hippo'));
  });

  it('honours HIPPO_HOME when it is set', () => {
    const custom = path.join(os.tmpdir(), 'hippo-getglobalroot-hh');
    vi.stubEnv('HIPPO_HOME', custom);
    expect(getGlobalRoot()).toBe(custom);
  });

  it('uses XDG_DATA_HOME/hippo when HIPPO_HOME is unset', () => {
    vi.stubEnv('HIPPO_HOME', undefined);
    const xdg = path.join(os.tmpdir(), 'hippo-getglobalroot-xdg');
    vi.stubEnv('XDG_DATA_HOME', xdg);
    expect(getGlobalRoot()).toBe(path.join(xdg, 'hippo'));
  });
});

// ---------------------------------------------------------------------------
// initGlobal / copyToGlobal
// ---------------------------------------------------------------------------

describe('copyToGlobal', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
    vi.stubEnv('HIPPO_HOME', globalRoot);
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('copies a local entry into the global store', async () => {
    const entry = createMemory('shared lesson about pipeline errors');
    writeEntry(localRoot, entry);

    // HIPPO_HOME is pointed at a temp global store in beforeEach, so this
    // promote lands in that temp store, not the developer's real ~/.hippo.
    const promoted = await copyToGlobal(localRoot, entry.id);
    expect(promoted.id).toMatch(/^g_/);
    expect(promoted.content).toBe(entry.content);
  });

  it('throws when ID does not exist in local store', async () => {
    await expect(copyToGlobal(localRoot, 'nonexistent_id')).rejects.toThrow();
  });

  it('honors opts.tenantId for cross-tenant isolation', async () => {
    const a = createMemory('tenant-a content', { tenantId: 'tenant-a' });
    const b = createMemory('tenant-b content', { tenantId: 'tenant-b' });
    writeEntry(localRoot, a);
    writeEntry(localRoot, b);

    // Promoting tenant-a's entry with opts.tenantId='tenant-a' succeeds.
    const promoted = await copyToGlobal(localRoot, a.id, { tenantId: 'tenant-a' });
    expect(promoted.id).toMatch(/^g_/);
    expect(promoted.content).toBe('tenant-a content');

    // Promoting tenant-a's entry as tenant-b throws: promote's tenant pre-check answers not found.
    await expect(copyToGlobal(localRoot, a.id, { tenantId: 'tenant-b' })).rejects.toThrow(/memory not found/);
  });
});

// ---------------------------------------------------------------------------
// syncGlobalToLocal
// ---------------------------------------------------------------------------

describe('syncGlobalToLocal', () => {
  let localRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    localRoot = makeTmpStore();
    globalRoot = makeTmpStore();
  });

  afterEach(() => {
    cleanUp(localRoot, globalRoot);
  });

  it('copies global entries into local', async () => {
    const entry1 = createMemory('global lesson one');
    const entry2 = createMemory('global lesson two');
    writeEntry(globalRoot, entry1);
    writeEntry(globalRoot, entry2);

    const count = await syncGlobalToLocal(...sharingStores(localRoot, globalRoot));
    expect(count).toBe(2);

    const localEntries = loadAllEntries(localRoot, 'default');
    const ids = localEntries.map((e) => e.id);
    expect(ids).toContain(entry1.id);
    expect(ids).toContain(entry2.id);
  });

  it('skips entries already in local store', async () => {
    const entry = createMemory('already local');
    writeEntry(globalRoot, entry);
    writeEntry(localRoot, entry); // already exists

    const count = await syncGlobalToLocal(...sharingStores(localRoot, globalRoot));
    expect(count).toBe(0);
  });

  it('returns 0 when global store does not exist', async () => {
    const nonexistent = path.join(os.tmpdir(), 'hippo-no-global-' + Date.now());
    const count = await syncGlobalToLocal(...sharingStores(localRoot, nonexistent));
    expect(count).toBe(0);
  });
});
