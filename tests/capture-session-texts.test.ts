// captureSessionTexts: the session-end capture for a caller that read its transcript on another machine.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../src/api.js';
import { BadRequestError } from '../src/api-errors.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { extractFromTexts } from '../src/capture/extract.js';
import { captureSessionTexts, type SessionCaptureRequest } from '../src/capture/session-texts.js';
import { collectSessionTurns, sessionTail } from '../src/capture/transcript.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { deriveOriginProject } from '../src/project-identity.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../src/store/rejection.js';
import { mergedText } from '../src/same-text.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { initProject, removeScratch, runHippo, scratch } from './_helpers/compaction-hooks.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const TEXTS = [
  'We decided to use pnpm for the billing service because the lockfile is pnpm-lock.yaml.',
  'Never run database migrations on a Friday afternoon because the on-call team is small.',
  'Gotcha: the staging cache must be flushed after every deploy of the search service.',
];
const ITEMS = extractFromTexts(TEXTS).map((i) => i.content);
const CALLER = { name: 'acme-web', legacyName: 'web' };
const ACTOR = 'api_key:k1';

let dir: string;
let repo: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-texts-'));
  // The store sits in a repo of its own, so a row stamped from its folder would read 'server-repo'.
  repo = path.join(dir, 'srv', 'server-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  root = path.join(repo, '.hippo');
  initStore(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ctxFor = (hippoRoot: string, tenantId = 'default'): Context => ({ hippoRoot, tenantId, actor: { subject: ACTOR, role: 'member' } });
const req = (texts: readonly string[], over: Partial<SessionCaptureRequest> = {}): SessionCaptureRequest =>
  ({ sessionId: 'sess-1', project: CALLER, texts, ...over });
const contents = (hippoRoot: string, tenantId = 'default'): string[] => loadAllEntries(hippoRoot, tenantId).map((e) => e.content).sort();

function reject(text: string): void {
  const db = openHippoDb(root);
  try {
    insertRejectedValue(db, {
      tenantId: 'default', digest: rejectionDigest(text), reason: 'test', rejectedBy: 'cli',
      rejectedAt: new Date().toISOString(), normalizedChars: normalizeValueForRejection(text).length,
    });
  } finally {
    closeHippoDb(db);
  }
}

function auditActors(op: 'remember' | 'reject_refusal', tenantId = 'default'): string[] {
  const db = openHippoDb(root);
  try {
    return queryAuditEvents(db, { tenantId, op }).map((e) => e.actor);
  } finally {
    closeHippoDb(db);
  }
}

describe('captureSessionTexts', () => {
  it('writes capture rows under the caller tenant, project and session, audited as the caller', () => {
    expect(ITEMS).toHaveLength(3);
    expect(deriveOriginProject(repo)).toBe('server-repo');
    expect(captureSessionTexts(ctxFor(root, 't1'), req(TEXTS))).toEqual({ captured: 3, skipped: 0, rejected: 0 });
    const rows = loadAllEntries(root, 't1');
    expect(rows.map((r) => r.content).sort()).toEqual([...ITEMS].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ source: 'capture', tenantId: 't1', origin_project: 'acme-web', source_session_id: 'sess-1' });
    }
    expect(auditActors('remember', 't1')).toEqual([ACTOR, ACTOR, ACTOR]);
    expect(loadAllEntries(root)).toHaveLength(3);
  });

  it('never stamps the folder of a store whose parent is no project', () => {
    const home = path.join(dir, 'home');
    const homeStore = path.join(home, '.hippo');
    // Before initStore, which resolves the folder's identity once and caches it.
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('HOME', home);
    try {
      initStore(homeStore);
      expect(deriveOriginProject(home)).toBe('');
      captureSessionTexts(ctxFor(homeStore), req(TEXTS));
      expect(loadAllEntries(homeStore, 'default').map((r) => r.origin_project)).toEqual(['acme-web', 'acme-web', 'acme-web']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes under the context tenant whatever else the request carries', () => {
    const smuggled = { ...req(TEXTS), global: true, tenantId: undefined, dryRun: true };
    expect(captureSessionTexts(ctxFor(root, 't9'), smuggled).captured).toBe(3);
    expect(loadAllEntries(root).map((r) => r.tenantId)).toEqual(['t9', 't9', 't9']);
  });

  it('throws on an empty project name and writes nothing', () => {
    expect(() => captureSessionTexts(ctxFor(root), req(TEXTS, { project: { name: '', legacyName: 'web' } }))).toThrow('project name must not be blank');
    expect(loadAllEntries(root)).toEqual([]);
  });

  // The shared store's own check: rows match names verbatim, so a rewritten name would split a project.
  it.each([
    ['an upper-case name', { name: 'Api', legacyName: 'api' }],
    ['a padded name', { name: ' api', legacyName: 'api' }],
    ['a name with a colon', { name: 'a:b', legacyName: 'api' }],
    ['an upper-case alias', { name: 'api', legacyName: 'api', aliases: ['Old-Api'] }],
    ['eleven aliases', { name: 'api', legacyName: 'api', aliases: Array.from({ length: 11 }, (_, i) => `a${i}`) }],
  ])('throws on %s and writes nothing', (_name, project) => {
    expect(() => captureSessionTexts(ctxFor(root), req(TEXTS, { project }))).toThrow(BadRequestError);
    expect(loadAllEntries(root)).toEqual([]);
  });

  it('captures for a lower-case name with aliases beside an upper-case legacy name', () => {
    const project = { name: 'api', legacyName: 'Api', aliases: ['acme-api', 'api-old'] };
    expect(captureSessionTexts(ctxFor(root), req(TEXTS, { project })).captured).toBe(3);
    expect(loadAllEntries(root).map((r) => r.origin_project)).toEqual(['api', 'api', 'api']);
  });

  it.each([
    ['a blank session id', { sessionId: '' }],
    ['a whitespace session id', { sessionId: ' \t ' }],
    ['a whitespace project name', { project: { name: '   ', legacyName: 'web' } }],
  ])('throws on %s and writes nothing', (_name, over) => {
    expect(() => captureSessionTexts(ctxFor(root), req(TEXTS, over))).toThrow(BadRequestError);
    expect(loadAllEntries(root)).toEqual([]);
  });

  it('scrubs the texts again, so a bearer token, an email and a home path never land', () => {
    const token = 'abcdef0123456789abcdef0123456789';
    const texts = [
      `We decided the release bot sends Authorization: Bearer ${token} on every deploy call.`,
      'We decided to mail the release notes to alice.dev@example.com after every billing deploy.',
      'Never edit C:\\Users\\alice.dev\\billing\\deploy.yml by hand because the pipeline regenerates it.',
    ];
    expect(captureSessionTexts(ctxFor(root), req(texts)).captured).toBe(3);
    const stored = contents(root).join('\n');
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('alice');
    expect(stored).toContain('[email]');
    expect(stored).toContain('[home]');
  });

  it('captures nothing new the second time, and only the missing items after a partial run', () => {
    expect(captureSessionTexts(ctxFor(root), req(TEXTS.slice(0, 1))).captured).toBe(1);
    expect(captureSessionTexts(ctxFor(root), req(TEXTS))).toEqual({ captured: 2, skipped: 1, rejected: 0 });
    expect(captureSessionTexts(ctxFor(root), req(TEXTS))).toEqual({ captured: 0, skipped: 3, rejected: 0 });
    expect(contents(root)).toEqual([...ITEMS].sort());
  });

  it('is blocked by the caller project and user-global copies, never by another project', () => {
    writeEntry(root, { ...createMemory(ITEMS[0]!), origin_project: 'other' });
    writeEntry(root, { ...createMemory(ITEMS[1]!), origin_project: '' });
    writeEntry(root, { ...createMemory(ITEMS[2]!), origin_project: 'web' });
    expect(captureSessionTexts(ctxFor(root), req(TEXTS))).toEqual({ captured: 1, skipped: 2, rejected: 0 });
    expect(loadAllEntries(root, 'default').filter((r) => r.origin_project === 'acme-web').map((r) => r.content)).toEqual([ITEMS[0]]);
  });

  it('is blocked by a sleep-merged row holding the text, never by another tenant', () => {
    const merged = mergedText('[Consolidated from 2 related memories, newest first]', [ITEMS[0]!, 'The search service reindexes nightly at two.']);
    writeEntry(root, { ...createMemory(merged), source: 'consolidation', origin_project: 'acme-web' });
    writeEntry(root, { ...createMemory(ITEMS[1]!, { tenantId: 'someone-else' }), origin_project: 'acme-web' });
    expect(captureSessionTexts(ctxFor(root), req(TEXTS))).toEqual({ captured: 2, skipped: 1, rejected: 0 });
  });

  it('counts a tombstoned value as rejected and audits the refusal as the caller', () => {
    reject(ITEMS[1]!);
    expect(captureSessionTexts(ctxFor(root), req(TEXTS))).toEqual({ captured: 2, skipped: 0, rejected: 1 });
    expect(auditActors('reject_refusal')).toEqual([ACTOR]);
  });

  it('prints nothing and never exits', () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit(${code})`); });
    reject(ITEMS[2]!);
    captureSessionTexts(ctxFor(root), req(TEXTS));
    captureSessionTexts(ctxFor(root), req(TEXTS));
    expect(() => captureSessionTexts(ctxFor(root), req(TEXTS, { project: { name: '', legacyName: '' } }))).toThrow(BadRequestError);
    for (const spy of [...spies, exit]) expect(spy).not.toHaveBeenCalled();
  });
});

describe('captureSessionTexts caps', () => {
  it.each([
    ['31 texts', Array.from({ length: 31 }, () => TEXTS[0]!)],
    ['a 33 KiB text', ['a'.repeat(33 * 1024)]],
    ['257 KiB in all', [...Array.from({ length: 8 }, () => 'a'.repeat(32 * 1024)), 'a'.repeat(1024)]],
  ])('rejects %s as a bad request and writes nothing', (_name, texts) => {
    expect(() => captureSessionTexts(ctxFor(root), req(texts))).toThrow(BadRequestError);
    expect(loadAllEntries(root)).toEqual([]);
  });

  it('writes the newest 50 of 60 items and counts the rest as skipped', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Never deploy the worker pool number ${i + 100} on a Friday because the on-call team is small.`).join('\n\n');
    const items = extractFromTexts([text]).map((i) => i.content);
    expect(items).toHaveLength(60);
    expect(captureSessionTexts(ctxFor(root), req([text]))).toEqual({ captured: 50, skipped: 10, rejected: 0 });
    expect(contents(root)).toEqual(items.slice(-50).sort());
  });
});

describe('captureSessionTexts against the CLI', () => {
  it('stores what `hippo capture --last-session` stores for the same transcript', () => {
    const s = scratch();
    try {
      initProject(s);
      const transcript = path.join(s.dir, 't.jsonl');
      const lines = TEXTS.flatMap((text) => [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'OK, noted.' }] } },
      ]);
      fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const cli = runHippo(['capture', '--last-session', '--transcript', transcript], s.proj, s.env, '');
      expect(cli.status, cli.stderr).toBe(0);

      const { users, assistants } = sessionTail(collectSessionTurns(fs.readFileSync(transcript, 'utf8')));
      captureSessionTexts(ctxFor(root), req([...users, ...assistants], { project: { name: 'proj', legacyName: 'proj' } }));
      expect(contents(root)).toEqual(contents(s.hippoRoot));
      expect(contents(root)).toEqual([...ITEMS].sort());
    } finally {
      removeScratch(s);
    }
  });
});
