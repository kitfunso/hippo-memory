/**
 * v39 S4 secret detection + producer/consumer vetoes
 * (docs/plans/2026-07-01-memory-scope-isolation.md).
 * Real-DB per project convention for the store-level tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSecret, redactSecrets, redactSecretsStrict } from '../src/secret-detect.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { shareMemory, autoShare, syncGlobalToLocal, promoteToGlobal, getGlobalRoot } from '../src/shared.js';
import { getContext, type Context } from '../src/api.js';
import { clearProjectIdentityCache } from '../src/project-identity.js';

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

describe('redactSecrets / redactSecretsStrict', () => {
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
    const canaries = [AWS, GHP, GH_PAT, SLACK, STRIPE, GOOGLE, PEM, SK_NO_KEYWORD, SK_X_NO_KEYWORD, ASSIGNMENT, BEARER, BEARER_UPPER, JWT, ...PROVIDER_TOKENS];
    for (const canary of canaries) {
      expect(redactSecretsStrict(`before ${canary} after`), canary).not.toContain(canary);
    }
  });

  it('redactSecretsStrict removes a Basic auth credential, as a header or quoted in JSON', () => {
    expect(redactSecretsStrict(`Authorization: Basic ${BASIC_CREDENTIAL}`)).not.toContain(BASIC_CREDENTIAL);
    expect(redactSecretsStrict(`{"authorization": "Basic ${BASIC_CREDENTIAL}"}`)).not.toContain(BASIC_CREDENTIAL);
  });

  it('plain redactSecrets removes the provider tokens too', () => {
    for (const token of PROVIDER_TOKENS) expect(redactSecrets(`before ${token} after`), token).not.toContain(token);
  });

  it('plain redactSecrets leaves the co-occurrence-guarded sk shapes alone with no keyword nearby', () => {
    expect(redactSecrets(`before ${SK_NO_KEYWORD} after`)).toContain(SK_NO_KEYWORD);
    expect(redactSecrets(`before ${SK_X_NO_KEYWORD} after`)).toContain(SK_X_NO_KEYWORD);
  });

  it('ordinary prose survives both', () => {
    const prose = 'the quarterly review covers risk-free rate assumptions and nothing else';
    expect(redactSecrets(prose)).toBe(prose);
    expect(redactSecretsStrict(prose)).toBe(prose);
  });

  it('redactSecretsStrict removes a JWT at the start, after a space, after Bearer, after = and inside JSON quotes', () => {
    for (const text of [`${JWT} was issued`, `the token is ${JWT}`, `Authorization: Bearer ${JWT}`, `jwt=${JWT}`, `{"id_token":"${JWT}"}`]) {
      expect(redactSecretsStrict(text), text).not.toContain('eyJ');
    }
  });

  it('redactSecretsStrict scrubs crafted 128 KiB runs of eyJ- and token= within 5x the time of prose', () => {
    const fill = (unit: string): string => unit.repeat(Math.ceil(131072 / unit.length)).slice(0, 131072);
    const prose = fill('the quarterly review covers risk-free rate assumptions and nothing else. ');
    for (const crafted of [fill('eyJ-'), fill('token=')]) {
      // The fastest of five interleaved runs of each text, so a GC pause or a busy runner weighs on both alike.
      let hostile = Infinity;
      let baseline = Infinity;
      for (let run = 0; run < 5; run++) {
        let started = performance.now();
        redactSecretsStrict(crafted);
        hostile = Math.min(hostile, performance.now() - started);
        started = performance.now();
        redactSecretsStrict(prose);
        baseline = Math.min(baseline, performance.now() - started);
      }
      // A ratio to prose holds on any runner speed, and rescanning the run from each repeat costs thousands of times prose.
      expect(hostile / baseline, crafted.slice(0, 6)).toBeLessThan(5);
    }
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
