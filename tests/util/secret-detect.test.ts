/**
 * v39 S4 secret detection + producer/consumer vetoes
 * (docs/plans/2026-07-01-memory-scope-isolation.md).
 * Real-DB per project convention for the store-level tests.
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { detectSecret, redactSecretsStrict } from '../../src/base/util/secret-detect.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { shareMemory, autoShare } from '../../src/domain/sharing/share.js';
import { syncGlobalToLocal } from '../../src/domain/sharing/global-sync.js';
import { getGlobalRoot } from '../../src/domain/sharing/global-store.js';
import { contextGet } from '../../src/api/index.js';
import { ASSIGNED_SECRET_LINES, ORDINARY_CONFIG_LINES } from '../_helpers/secret-shapes.js';
import { fillTo, ONE_MIB, scanWithinWatchdog, WATCHDOG_MS } from '../_helpers/scan-watchdog.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { copyToGlobal, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

// Built at runtime, so no secret-shaped literal sits in source.
const HIPPO_KEY = 'hk_' + 'a'.repeat(24) + '.' + 'b'.repeat(32);
const NPM = 'npm_' + 'A1'.repeat(18);
const HF = 'hf_' + 'Ab'.repeat(17);
const GLPAT = 'glpat-' + 'A1_-'.repeat(5);
const YA29 = 'ya29.' + 'a0Af'.repeat(10);
const SLACK_HOOK = 'https://hooks.slack.com/services/T' + 'A'.repeat(8) + '/B' + 'B'.repeat(8) + '/' + 'C'.repeat(24);
const PROVIDER_TOKENS = [HIPPO_KEY, NPM, HF, GLPAT, YA29, SLACK_HOOK];

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
    expect(flagged('project-i prod API key for the personal account: sk_vendor_1a2b3c4d')).toBe(true);
    expect(flagged('config sets api_key=9f8e7d6c5b4a3210ffff')).toBe(true);
  });

  it('flags hippo, npm, Hugging Face, GitLab, Google OAuth and Slack webhook tokens', () => {
    for (const token of PROVIDER_TOKENS) expect(flagged(`deploy note: ${token}`), token).toBe(true);
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
    expect(flagged('npm_config_cache and hf_hub_download are names; the hk_ prefix marks hippo keys')).toBe(false);
  });

  it('does not flag code snippets or prose in assignment position', () => {
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

  it.each([
    ['a prefixed password', 'run DB_PASSWORD=' + 'Hunter2Hunter2' + ' before the migration'],
    ['a prefixed token', 'set MY_API_TOKEN=' + 'abc123def456ghi789'],
    ['a prefixed secret after a colon', 'CLIENT_SECRET: ' + '4f9a8b7c6d5e4f3a2b1c'],
    [
      'a name that runs on past the keyword',
      'AWS_SECRET_ACCESS_KEY=' + 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY',
    ],
    ['a lower-case prefixed name', 'aws_secret_access_key=' + 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY'],
    ['a URL password', 'DATABASE_URL=postgres://admin:' + 'S3cretPw9' + '@localhost:5432/app'],
    ['a passwd name', 'export SMTP_PASSWD=' + 'Tr0ub4dor3x99'],
    ['a private key name', 'PRIVATE_KEY=' + '9f8e7d6c5b4a3210ffee'],
    ['an access key name', 'S3_ACCESS_KEY=' + 'AKQ7Z2X9W4V1U8T3'],
  ])('flags %s', (_name, content) => {
    expect(flagged(content)).toBe(true);
  });

  it.each([
    ['a name that only starts with a keyword', 'tokenizer: bert-base-uncased-v2 for the eval'],
    ['a counter named after tokens', 'set max_tokens=4096 for the long runs'],
    ['a URL template with no real password', 'connection strings look like postgres://user:password@host:5432/db'],
    ['an ssh remote with a user and no password', 'clone ssh://git@github.com:22/acme/repo2.git'],
  ])('does not flag %s', (_name, content) => {
    expect(flagged(content)).toBe(false);
  });

  it.each(ASSIGNED_SECRET_LINES)('flags the assigned secret in %s', (content) => {
    expect(detectSecret({ content, tags: [] })).toEqual({ flagged: true, reason: 'pattern:secret-assignment' });
  });

  it.each(ORDINARY_CONFIG_LINES)('does not flag the ordinary config %s', (content) => {
    expect(detectSecret({ content, tags: [] })).toEqual({ flagged: false, reason: null });
  });

  it('reads no password from a URL whose query holds an @, and still reads one before the host', () => {
    const query = 'http://localhost:8080?next=a@b.co';
    expect(flagged(query)).toBe(false);
    expect(redactSecretsStrict(query)).toBe(query);
    const withPassword = `https://user:${'p4ss' + 'w0rd'}@host/x`;
    expect(detectSecret({ content: withPassword, tags: [] }).reason).toBe('pattern:url-password');
    expect(redactSecretsStrict(withPassword)).toBe('https://[REDACTED]@host/x');
  });
});

describe('redactSecretsStrict', () => {
  // Built at runtime, so no secret-shaped literal sits in source.
  const AWS = 'AKIA' + '1234567890ABCDEF';
  const GHP = 'ghp_' + 'A'.repeat(36);
  const GH_PAT = 'github_pat_' + 'A'.repeat(24);
  const SLACK = 'xoxb-' + '1234567890abcdef';
  const STRIPE = 'sk_live_' + 'A1b2C3d4E5f6G7h8';
  const GOOGLE = 'AIza' + 'A'.repeat(35);
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(64) + '\n-----END RSA PRIVATE KEY-----';
  const SK_NO_KEYWORD = 'sk-' + 'A'.repeat(24);
  const SK_X_NO_KEYWORD = 'sk_' + 'vendor_deadbeef123456';
  const ASSIGNMENT = 'api_key=' + '9f8e7d6c5b4a3210' + 'ffff';
  const BEARER = 'Bearer ' + 'A'.repeat(20);
  const BEARER_UPPER = 'BEARER ' + 'D'.repeat(20);
  const JWT = 'eyJ' + 'A'.repeat(10) + '.eyJ' + 'B'.repeat(10) + '.' + 'C'.repeat(10);
  const BASIC_CREDENTIAL = Buffer.from(`alice:${'p'.repeat(12)}`).toString('base64');

  it('redactSecretsStrict removes every canary shape, keyword context or not', () => {
    const canaries = [
      AWS,
      GHP,
      GH_PAT,
      SLACK,
      STRIPE,
      GOOGLE,
      PEM,
      SK_NO_KEYWORD,
      SK_X_NO_KEYWORD,
      ASSIGNMENT,
      BEARER,
      BEARER_UPPER,
      JWT,
      ...PROVIDER_TOKENS,
    ];
    for (const canary of canaries) {
      expect(redactSecretsStrict(`before ${canary} after`), canary).not.toContain(canary);
    }
  });

  it('redactSecretsStrict removes a Basic auth credential, as a header or quoted in JSON', () => {
    expect(redactSecretsStrict(`Authorization: Basic ${BASIC_CREDENTIAL}`)).not.toContain(BASIC_CREDENTIAL);
    expect(redactSecretsStrict(`{"authorization": "Basic ${BASIC_CREDENTIAL}"}`)).not.toContain(BASIC_CREDENTIAL);
  });

  it('ordinary prose survives', () => {
    const prose = 'the quarterly review covers risk-free rate assumptions and nothing else';
    expect(redactSecretsStrict(prose)).toBe(prose);
  });

  it('redactSecretsStrict removes a JWT at the start, after a space, after Bearer, after = and inside JSON quotes', () => {
    for (const text of [
      `${JWT} was issued`,
      `the token is ${JWT}`,
      `Authorization: Bearer ${JWT}`,
      `jwt=${JWT}`,
      `{"id_token":"${JWT}"}`,
    ]) {
      expect(redactSecretsStrict(text), text).not.toContain('eyJ');
    }
  });

  // JavaScript counts no regex backtracking steps; rescanning a 1 MiB run from every repeat outlasts the watchdog by hours.
  it.each(['eyJ-', 'token='])(
    'redactSecretsStrict scrubs a crafted 1 MiB run of %s before the watchdog fires',
    (unit) => {
      expect(() => scanWithinWatchdog(redactSecretsStrict, fillTo(unit, ONE_MIB), WATCHDOG_MS)).not.toThrow();
    },
  );
});

describe('producer + sync vetoes (real stores)', () => {
  let tmpRoot: string;
  let projA: string;
  let globalStore: string;
  let origHippoHome: string | undefined;

  const SECRET_ROW = 'service api key sk_vendor_deadbeef123456 for the ingest worker';
  const CLEAN_ROW = 'gotcha: powershell 5.1 has no pipeline chain operators, use if blocks';

  beforeEach(() => {
    tmpRoot = makeRoot('secret', { init: false });
    projA = path.join(tmpRoot, 'proj-a', '.hippo');
    fs.mkdirSync(projA, { recursive: true });
    initTestStore(projA);
    globalStore = path.join(tmpRoot, 'globalstore');
    initTestStore(globalStore);
    origHippoHome = process.env.HIPPO_HOME;
    vi.stubEnv('HIPPO_HOME', globalStore);
  });

  afterEach(() => {
    if (origHippoHome !== undefined) {
      vi.stubEnv('HIPPO_HOME', origHippoHome);
    } else {
      vi.stubEnv('HIPPO_HOME', undefined);
    }
  });

  it('shareMemory refuses a secret row even with force', async () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true }));
    const [row] = loadAllEntries(projA, 'default');
    await expect(shareMemory(...sharingStores(projA), row.id, { tenantId: 'default', force: true })).rejects.toThrow(
      /secret/i,
    );
    expect(loadAllEntries(getGlobalRoot(), 'default')).toHaveLength(0);
  });

  it('autoShare silently skips secret rows and still shares clean ones', async () => {
    // error tag + pin push transferScore over the 0.6 bar for both rows.
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    const shared = await autoShare(...sharingStores(projA), { tenantId: ALL_TENANTS, minScore: 0.6 });
    expect(shared.map((e) => e.content)).toEqual([CLEAN_ROW]);
  });

  it('autoShare stats counts only shares actually withheld by the secret veto', async () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    // Below the transfer bar: secret-flagged but never a share candidate, so
    // it must NOT increment the counter.
    writeEntry(projA, createMemory('low transfer secret sk_vendor_cafebabe999888 note'));
    const stats = { secretSkipped: 0 };
    const shared = await autoShare(...sharingStores(projA), { tenantId: ALL_TENANTS, minScore: 0.6, stats });
    expect(shared.map((e) => e.content)).toEqual([CLEAN_ROW]);
    expect(stats.secretSkipped).toBe(1);
  });

  it('autoShare fills stats identically under dryRun', async () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true, tags: ['error', 'gotcha'] }));
    const stats = { secretSkipped: 0 };
    const candidates = await autoShare(...sharingStores(projA), {
      tenantId: ALL_TENANTS,
      minScore: 0.6,
      dryRun: true,
      stats,
    });
    expect(candidates).toHaveLength(0);
    expect(stats.secretSkipped).toBe(1);
    expect(loadAllEntries(getGlobalRoot(), 'default')).toHaveLength(0);
  });

  it('copyToGlobal refuses a secret row and stamps origin on clean promotes', async () => {
    writeEntry(projA, createMemory(SECRET_ROW, { pinned: true }));
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true }));
    const rows = loadAllEntries(projA, 'default');
    const secretRow = rows.find((e) => e.content === SECRET_ROW)!;
    const cleanRow = rows.find((e) => e.content === CLEAN_ROW)!;
    await expect(copyToGlobal(projA, secretRow.id)).rejects.toThrow(/secret/i);
    const promoted = await copyToGlobal(projA, cleanRow.id);
    expect(promoted.originProject).toBe('proj-a');
    expect(loadAllEntries(getGlobalRoot(), 'default').map((e) => e.content)).toEqual([CLEAN_ROW]);
  });

  it('shareMemory stamps the canonical origin on the global copy', async () => {
    writeEntry(projA, createMemory(CLEAN_ROW, { pinned: true }));
    const [row] = loadAllEntries(projA, 'default');
    const globalCopy = await shareMemory(...sharingStores(projA), row.id, { tenantId: 'default', force: true });
    expect(globalCopy?.originProject).toBe('proj-a');
    expect(globalCopy?.source).toMatch(/^shared:proj-a:/);
  });

  it('syncGlobalToLocal skips secrets and other-project rows, preserves origin on copies', async () => {
    writeEntry(globalStore, { ...createMemory(CLEAN_ROW), originProject: '' });
    writeEntry(globalStore, { ...createMemory('project b routing table quirk'), originProject: 'proj-b' });
    writeEntry(globalStore, { ...createMemory(SECRET_ROW), originProject: '' });

    const count = await syncGlobalToLocal(...sharingStores(projA, globalStore));
    expect(count).toBe(1);
    const local = loadAllEntries(projA, 'default');
    expect(local.map((e) => e.content)).toEqual([CLEAN_ROW]);
    expect(local[0].originProject).toBe('');

    const withCross = await syncGlobalToLocal(...sharingStores(projA, globalStore), { includeCrossProject: true });
    expect(withCross).toBe(1); // proj-b row now copies; the secret still never does
    expect(loadAllEntries(projA, 'default').map((e) => e.content)).not.toContain(SECRET_ROW);
  });

  it('ambient context never injects a secret outside its owning project, even cross-project or with isolation off', async () => {
    writeEntry(globalStore, { ...createMemory(SECRET_ROW, { pinned: true }), originProject: 'proj-b' });
    writeEntry(globalStore, {
      ...createMemory('a user-global secret sk_vendor_cafe0123456', { pinned: true }),
      originProject: '',
    });
    const ctx: FullContext = apiCtx(projA, 'default', { subject: 'cli', role: 'admin' });

    const base = await contextGet(ctx, { pinnedOnly: true, currentProject: 'proj-a' });
    expect(base.entries).toHaveLength(0);

    const cross = await contextGet(ctx, { pinnedOnly: true, currentProject: 'proj-a', crossProject: true });
    expect(cross.entries).toHaveLength(0);

    fs.writeFileSync(path.join(projA, 'config.json'), JSON.stringify({ contextProjectIsolation: false }));
    const legacyMode = await contextGet(ctx, { pinnedOnly: true, currentProject: 'proj-a' });
    expect(legacyMode.entries).toHaveLength(0);

    // Inside the owning project the project-owned secret is ambient again;
    // the origin-less one stays out everywhere.
    const owner = await contextGet(ctx, { pinnedOnly: true, currentProject: 'proj-b' });
    expect(owner.entries.map((r) => r.entry.content)).toEqual([SECRET_ROW]);
  });
});
