/**
 * v39 S4 secret detection + producer/consumer vetoes
 * (docs/plans/2026-07-01-memory-scope-isolation.md).
 * Real-DB per project convention for the store-level tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSecret } from '../src/secret-detect.js';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { shareMemory, autoShare, syncGlobalToLocal, promoteToGlobal, getGlobalRoot } from '../src/shared.js';
import { getContext, type Context } from '../src/api.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';

describe('detectSecret patterns', () => {
  const flagged = (content: string, tags: string[] = []) => detectSecret({ content, tags }).flagged;

  it('flags real key shapes', () => {
    expect(flagged('aws creds AKIAIOSFODNN7EXAMPLE for the deploy user')).toBe(true);
    expect(flagged('gh token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    expect(flagged('slack bot xoxb-123456789012-abcdefghij')).toBe(true);
    expect(flagged('stripe sk_live_abcdefghijklmnop1234')).toBe(true);
    expect(flagged('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(flagged('the prod API key is sk-abcdefghij0123456789xyz')).toBe(true);
    // The shape from the 2026-06-30 incident (synthetic value - never a real key).
    expect(flagged('2chain prod API key for keith-personal: sk_vendor_1a2b3c4d')).toBe(true);
    expect(flagged('config sets api_key=9f8e7d6c5b4a3210ffff')).toBe(true);
  });

  it('flags by tag regardless of content', () => {
    expect(flagged('rotate quarterly', ['api-key'])).toBe(true);
    expect(flagged('rotate quarterly', ['SECRET'])).toBe(true);
  });

  it('does not flag benign prose', () => {
    expect(flagged('the ghp_ prefix identifies GitHub personal access tokens')).toBe(false);
    expect(flagged('use sklearn for the regression baseline')).toBe(false);
    expect(flagged('the risk-free rate assumption is 4.2 percent')).toBe(false);
    expect(flagged('prefer parameterized queries; never concatenate SQL')).toBe(false);
    expect(flagged('password rotation policy: every 90 days, no reuse')).toBe(false);
    expect(flagged('sk-hyphenated-words-in-prose read fine in plain writing')).toBe(false);
  });

  it('does not flag code snippets or prose in assignment position (post-merge review FPs)', () => {
    // Both were verified false positives of the pre-fix generic pattern:
    // ordinary code-lesson memories would silently vanish from ambient
    // context everywhere. The value must now LOOK like a credential
    // (token charset + at least one digit).
    expect(flagged('lesson: token = estimateTokens(entry.content) counts words not chars')).toBe(false);
    expect(flagged('the secret: incremental-rollout worked well for the beta')).toBe(false);
    // Credential-shaped values still flag.
    expect(flagged('password: MyDogsName2024x')).toBe(true);
    expect(flagged('config sets api_key=9f8e7d6c5b4a3210ffff')).toBe(true);
  });
});

describe('producer + sync vetoes (real stores)', () => {
  let tmpRoot: string;
  let projA: string;
  let globalStore: string;
  let origHippoHome: string | undefined;

  const SECRET_ROW = 'service api key sk_vendor_deadbeef123456 for the ingest worker';
  const CLEAN_ROW = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-'));
    projA = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(projA, { recursive: true });
    initStore(projA);
    globalStore = path.join(tmpRoot, 'globalstore');
    initStore(globalStore);
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalStore;
    clearProjectIdentityCache();
  });

  afterEach(() => {
    if (origHippoHome !== undefined) {
      process.env.HIPPO_HOME = origHippoHome;
    } else {
      delete process.env.HIPPO_HOME;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('shareMemory refuses a secret row even with force', () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true }));
    const [row] = loadAllEntries(projA);
    expect(() => shareMemory(projA, row.id, { force: true })).toThrow(/secret/i);
    expect(loadAllEntries(getGlobalRoot())).toHaveLength(0);
  });

  it('autoShare silently skips secret rows and still shares clean ones', () => {
    // error tag + pin push transferScore over the 0.6 bar for both rows.
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    const shared = autoShare(projA, { minScore: 0.6 });
    expect(shared.map((e) => e.content)).toEqual([CLEAN_ROW]);
  });

  it('autoShare stats counts only shares actually withheld by the secret veto (v1.25.0)', () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    // Below the transfer bar: secret-flagged but never a share candidate, so
    // it must NOT increment the counter.
    writeEntry(projA, createMemory('low transfer secret sk_vendor_cafebabe999888 note'));
    const stats = { secretSkipped: 0 };
    const shared = autoShare(projA, { minScore: 0.6, stats });
    expect(shared.map((e) => e.content)).toEqual([CLEAN_ROW]);
    expect(stats.secretSkipped).toBe(1);
  });

  it('autoShare fills stats identically under dryRun (v1.25.0)', () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    const stats = { secretSkipped: 0 };
    const candidates = autoShare(projA, { minScore: 0.6, dryRun: true, stats });
    expect(candidates).toHaveLength(0);
    expect(stats.secretSkipped).toBe(1);
    expect(loadAllEntries(getGlobalRoot())).toHaveLength(0);
  });

  it('promoteToGlobal refuses a secret row and stamps origin on clean promotes', () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true }));
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true }));
    const rows = loadAllEntries(projA);
    const secretRow = rows.find((e) => e.content === SECRET_ROW)!;
    const cleanRow = rows.find((e) => e.content === CLEAN_ROW)!;
    expect(() => promoteToGlobal(projA, secretRow.id)).toThrow(/secret/i);
    const promoted = promoteToGlobal(projA, cleanRow.id);
    expect(promoted.origin_project).toBe('proj-a');
    expect(loadAllEntries(getGlobalRoot()).map((e) => e.content)).toEqual([CLEAN_ROW]);
  });

  it('shareMemory stamps the canonical origin on the global copy', () => {
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true }));
    const [row] = loadAllEntries(projA);
    const globalCopy = shareMemory(projA, row.id, { force: true });
    expect(globalCopy?.origin_project).toBe('proj-a');
    expect(globalCopy?.source).toMatch(/^shared:proj-a:/);
  });

  it('syncGlobalToLocal skips secrets and other-project rows, preserves origin on copies', () => {
    writeEntry(globalStore, { ...createMemory(CLEAN_ROW), origin_project: '' });
    writeEntry(globalStore, { ...createMemory('project b routing table quirk'), origin_project: 'proj-b' });
    writeEntry(globalStore, { ...createMemory(SECRET_ROW), origin_project: '' });

    const count = syncGlobalToLocal(projA, globalStore);
    expect(count).toBe(1);
    const local = loadAllEntries(projA);
    expect(local.map((e) => e.content)).toEqual([CLEAN_ROW]);
    expect(local[0].origin_project).toBe('');

    const withCross = syncGlobalToLocal(projA, globalStore, { includeCrossProject: true });
    expect(withCross).toBe(1); // proj-b row now copies; the secret still never does
    expect(loadAllEntries(projA).map((e) => e.content)).not.toContain(SECRET_ROW);
  });

  it('ambient context never injects a secret outside its owning project, even cross-project or with isolation off', async () => {
    writeEntry(globalStore, { ...createMemory(SECRET_ROW, { pinned: true }), origin_project: 'proj-b' });
    writeEntry(globalStore, { ...createMemory('a user-global secret sk_vendor_cafe0123456', { pinned: true }), origin_project: '' });
    const ctx: Context = { hippoRoot: projA, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };

    const base = await getContext(ctx, { pinnedOnly: true, currentProject: 'proj-a' });
    expect(base.entries).toHaveLength(0);

    const cross = await getContext(ctx, { pinnedOnly: true, currentProject: 'proj-a', crossProject: true });
    expect(cross.entries).toHaveLength(0);

    fs.writeFileSync(path.join(projA, 'config.json'), JSON.stringify({ contextProjectIsolation: false }));
    const legacyMode = await getContext(ctx, { pinnedOnly: true, currentProject: 'proj-a' });
    expect(legacyMode.entries).toHaveLength(0);

    // Inside the owning project the project-owned secret is ambient again;
    // the origin-less one stays out everywhere.
    const owner = await getContext(ctx, { pinnedOnly: true, currentProject: 'proj-b' });
    expect(owner.entries.map((r) => r.entry.content)).toEqual([SECRET_ROW]);
  });
});
