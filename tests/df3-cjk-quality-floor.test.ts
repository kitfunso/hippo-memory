/**
 * DF3 follow-up (codex review) — `substantiveWordCount` (src/audit.ts) is not
 * locale-aware: it splits on `/\s+/`, so a whitespace-free CJK sentence reads
 * as a single "word" and fails the `< 2` substantive-word-count check inside
 * `isContentWorthStoring`. That heuristic gates both the `includeRecent`
 * quality floor (src/api.ts:2484) and capture's write path
 * (src/capture.ts:174), so the bug silently dropped real CJK memories at
 * write time, not just at read time.
 *
 * The fix counts CJK characters as substantive units (~2 chars per "word",
 * the typical CJK word length) alongside the existing whitespace-delimited
 * latin word count, counted separately so a run isn't scored twice.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isContentWorthStoring } from '../src/audit.js';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { getContext, type Context } from '../src/api.js';

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'hippo-df3-cjk-'));
  initStore(home);
  const globalTmp = mkdtempSync(join(tmpdir(), 'hippo-df3-cjk-global-'));
  const origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = globalTmp;
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(globalTmp, { recursive: true, force: true });
      if (origHippoHome !== undefined) {
        process.env.HIPPO_HOME = origHippoHome;
      } else {
        delete process.env.HIPPO_HOME;
      }
    },
  };
}

function seed(home: string, content: string, opts: { created?: string } = {}) {
  const entry = createMemory(content, { layer: Layer.Episodic, tenantId: 'default' });
  if (opts.created) entry.created = opts.created;
  writeEntry(home, entry);
  return entry;
}

const CJK_SENTENCE = 'データベース接続がタイムアウトしたときは再試行の間隔を二倍にする';

describe('DF3 follow-up — CJK-aware substantiveWordCount (src/audit.ts)', () => {
  it('(a) a substantive CJK sentence passes isContentWorthStoring', () => {
    expect(isContentWorthStoring(CJK_SENTENCE)).toBe(true);
  });

  it('(a) a substantive CJK sentence is returned via includeRecent', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: Context = { hippoRoot: home, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
      seed(home, CJK_SENTENCE, { created: '2026-08-20T10:00:00.000Z' });

      const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 1, budget: 500 });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain(CJK_SENTENCE);
    } finally {
      restore();
    }
  });

  it('(b) a genuinely junk short CJK token is still rejected', () => {
    // Below the 10-char length floor either way, but this also proves the
    // CJK-run counting alone doesn't bypass the length gate — the fix only
    // ever admits content, it never widens the reject-short-content path.
    expect(isContentWorthStoring('設定変更')).toBe(false);
    expect(isContentWorthStoring('了解')).toBe(false);
  });

  it('(c) existing latin classification is unchanged (before/after parity)', () => {
    // Pulled from tests/df3-recent-quality-floor.test.ts's existing fixtures.
    const expectations: Array<[string, boolean]> = [
      ['fixed signals', false],
      ['clean memory number one with plenty of specific detail worth keeping', true],
      ['quick patch applied', false],
      ['tweaked config again', false],
      ['globe view on by default', false],
      ['fetches a quote → blank price', true],
      ['bump to v1.2.3', false],
      ['0.24.1', false],
      ['chore: release 1.2.3', false],
      ['Merge branch main into feature', false],
      ['WIP work in progress', false],
    ];
    for (const [content, expected] of expectations) {
      expect(isContentWorthStoring(content)).toBe(expected);
    }
  });
});
