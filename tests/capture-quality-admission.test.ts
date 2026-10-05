import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromText } from '../src/capture/extract.js';
import { summariseSessionTurns, type SessionTurn } from '../src/capture/transcript.js';
import { extractLessons, partitionLessons } from '../src/autolearn.js';
import { getContext, type Context } from '../src/api.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer } from '../src/memory.js';
import { initStore, openStore } from '../src/store/open.js';
import { closeHippoDb } from '../src/db.js';
import { gatedWrite } from '../src/gated-write.js';
import { writeEntry } from '../src/store/entry-writes.js';

describe('capture retains complete supported assertions', () => {
  it('rejects the reported fragment, outcome and stripped build commit', () => {
    expect(extractFromText('Error: Found local migration files to be')).toEqual([]);
    expect(extractFromText('Rule: succeeds (inserts or updates)')).toEqual([]);
    const parsed = extractLessons('0f26e3e chore: bump build 78 for testflight deploy');
    expect(parsed).toEqual(['bump build 78 for testflight deploy']);
    expect(partitionLessons(parsed)).toEqual({ kept: [], dropped: parsed });
  });

  it('keeps subjects, comparisons, negation, reasons and conditions', () => {
    const statements = [
      'We decided to use SQLite because the app must work offline.',
      'Prefer pnpm over npm because the repository uses pnpm-lock.yaml.',
      'Decision: we use pnpm, never npm, because the lockfile is pnpm-lock.yaml.',
      'The search cache must be flushed when the deployment changes its schema.',
      'If the API returns HTTP 429, always retry after the Retry-After delay.',
      'Never touch the generated config, because the deploy step rewrites it.',
    ];
    for (const statement of statements) {
      const [item] = extractFromText(statement);
      expect(item?.content, statement).toBe(statement.replace(/^Decision: /, '').replace(/\.$/, ''));
    }
  });

  it('keeps complete long sentences within the bound and skips overlong ones', () => {
    const supported = `Always preserve the source assertion because ${'the data matters '.repeat(14)}and the reviewer needs its full context.`;
    expect(supported.length).toBeGreaterThan(200);
    expect(supported.length).toBeLessThan(500);
    expect(extractFromText(supported)[0]?.content).toBe(supported.slice(0, -1));
    expect(extractFromText(`Always preserve ${'the original data '.repeat(35)}before changing it.`)).toEqual([]);
  });

  it('excludes fenced and quoted output while retaining inline code', () => {
    const text = ['```text', 'Error: migrate users to the production database.', '```', '> Rule: succeeds (inserts or updates)', 'Never call `write(a, b)` before validating the tenant.'].join('\n');
    expect(extractFromText(text).map((item) => item.content)).toEqual(['Never call `write(a, b)` before validating the tenant']);
  });

  it('joins wrapped reasons and conditions without mining a wrapped error log', () => {
    const text = ['The API must retry after HTTP 429', 'because the provider enforces a per-account quota.', '', 'LegacyDbPushMissingRemoteError: Found local migration files to be', 'inserted before the last migration on remote database.'].join('\n');
    expect(extractFromText(text).map((item) => item.content)).toEqual(['The API must retry after HTTP 429 because the provider enforces a per-account quota']);
  });

  it('does not manufacture a source assertion by clipping a transcript turn', () => {
    const user = `Decision: the release app ${'uses the shared configuration '.repeat(22)}because the signed package must match the manifest.`;
    const assistant = `The storage service must ${'retain the source details '.repeat(95)}until verification finishes.`;
    const summary = summariseSessionTurns([{ role: 'user', text: user }, { role: 'assistant', text: assistant }]);
    expect(summary).toContain(user);
    expect(summary).toContain(assistant);
    expect(extractFromText(summary)).toEqual([]);
  });

  it('never joins adjacent transcript turns into one memory', () => {
    const turns: SessionTurn[] = [
      { role: 'user', text: 'Never edit the lockfile by hand' },
      { role: 'user', text: 'thanks' },
      { role: 'assistant', text: 'You must never run the migration twice, because the second run deletes the seed rows' },
      { role: 'assistant', text: 'succeeds (inserts or updates)' },
      { role: 'assistant', text: 'Here is the file:' },
    ];
    expect(extractFromText(summariseSessionTurns(turns)).map((item) => item.content)).toEqual([
      'Never edit the lockfile by hand',
      'You must never run the migration twice, because the second run deletes the seed rows',
    ]);
  });

  it('splits one statement per capitalised line and drops non-statements', () => {
    const text = [
      'Never edit the lockfile by hand',
      'Always run the linter before you push',
      'Should we always rebase before merging?',
      '- [x] Never skip the migration check on release branches',
      '| Never | trust a table cell as a rule |',
      '    always = true  # indented code, never a rule',
      '```',
      'Never push from the VM',
      '```',
      'The fallback (never used in prod) must stay behind the feature flag.',
    ].join('\n');
    expect(extractFromText(text).map((item) => item.content)).toEqual([
      'Never edit the lockfile by hand',
      'Always run the linter before you push',
      'Never skip the migration check on release branches',
      'The fallback (never used in prod) must stay behind the feature flag',
    ]);
  });
});

describe('automatic quality does not govern manual or trusted import storage', () => {
  let scratch: string;
  let root: string;
  let priorHome: string | undefined;
  let ctx: Context;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hippo-quality-context-'));
    root = join(scratch, 'project', '.hippo');
    initStore(root);
    const global = join(scratch, 'global');
    initStore(global);
    priorHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = global;
    ctx = { hippoRoot: root, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = priorHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('keeps complete manual/import preferences in recent context and keeps pins under existing rules', async () => {
    const manual = createMemory('Prefer pnpm for dependency installs', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, source: 'cli', layer: Layer.Episodic });
    const imported = createMemory('Use SQLite for the offline cache', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, source: 'claude-code', tags: ['agent-memory'], layer: Layer.Episodic });
    const pin = { ...createMemory('Use tabs', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), pinned: true };
    const noise = createMemory('Found local migration files to be', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, source: 'capture', confidence: 'observed', layer: Layer.Episodic });
    for (const entry of [manual, pin, noise]) writeEntry(root, entry);
    const db = openStore(root);
    try { expect(gatedWrite(db, root, imported, { worthCheck: false })).toBe('written'); }
    finally { closeHippoDb(db); }
    const recent = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: 'project' });
    const ids = recent.entries.map(({ entry }) => entry.id);
    expect(ids).toContain(manual.id);
    expect(ids).toContain(imported.id);
    expect(ids).toContain(pin.id);
    expect(ids).not.toContain(noise.id);
  });

  it('surfaces hand-written rules the automatic check would refuse', async () => {
    const texts = [
      'Failed migrations must be rolled back by hand on the VM',
      'Never force-push unless you must',
      'Always check which branch the PR merges into',
      'To deploy the site run npm run deploy in website/',
    ];
    const manual = texts.map((text) => createMemory(text, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, source: 'cli', layer: Layer.Episodic }));
    for (const entry of manual) writeEntry(root, entry);
    const recent = await getContext(ctx, { pinnedOnly: true, includeRecent: 10, currentProject: 'project' });
    expect(recent.entries.map(({ entry }) => entry.content).sort()).toEqual([...texts].sort());
  });
});
