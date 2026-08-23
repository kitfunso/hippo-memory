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

  // codex review round 2 found BOTH of these as regressions in the first
  // locale-aware draft. They pin the two properties the counter must hold.
  it('kana punctuation is not substantive: a punctuation-only string stays rejected', () => {
    // The Katakana BLOCK contains the middle dot and the prolonged sound mark.
    // A block-range match counted them as words, so punctuation-only junk
    // passed the shared gate and capture would have admitted it.
    expect(isContentWorthStoring('・'.repeat(10))).toBe(false);
    expect(isContentWorthStoring('ー'.repeat(10))).toBe(false);
  });

  it('mixed latin+CJK tokens keep their prior count: previously-accepted content is not newly rejected', () => {
    // Stripping CJK before the latin split left three 2-char fragments that
    // fail the `> 2` filter, dropping this from 3 substantive tokens to 1 and
    // making capture silently discard it. The count must be ADDITIVE.
    expect(isContentWorthStoring('UI層 DB層 QA層')).toBe(true);
  });

  // STRUCTURAL GUARD (three codex rounds earned this). Every defect here was
  // the same shape: a property of the character class asserted in a comment
  // but never tested, with review supplying the adversarial input. This sweep
  // asserts the invariant itself - only Unicode LETTERS count toward the
  // substantive floor - so a future wrong guess about which ranges or
  // properties to match fails here rather than in review.
  it('invariant sweep: only Unicode letters count toward the floor', () => {
    const nonLetters: ReadonlyArray<readonly [string, string]> = [
      ['katakana middle dot', '\u30fb'],
      ['prolonged sound mark', '\u30fc'],
      ['Kangxi radical', '\u2f00'],
      ['old Chinese hook mark', '\u{16fe2}'],
      ['ideographic full stop', '\u3002'],
      ['fullwidth comma', '\uff0c'],
    ];
    for (const [label, ch] of nonLetters) {
      // 20 repetitions is far past the >= 2 substantive-unit floor, so any of
      // these counting as a letter would flip the verdict to true.
      expect(isContentWorthStoring(ch.repeat(20)), label).toBe(false);
    }

    const letters: ReadonlyArray<readonly [string, string]> = [
      ['han', '\u6e2c\u8a66\u74b0\u5883\u306e\u63a5\u7d9a\u8a2d\u5b9a\u3092\u5909\u66f4'],
      ['hiragana', '\u3055\u3044\u3057\u3087\u306e\u3066\u3063\u305a\u304c\u304a\u3061\u308b'],
      ['katakana', '\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9\u30b3\u30cd\u30af\u30b7\u30e7\u30f3'],
    ];
    for (const [label, text] of letters) {
      expect(isContentWorthStoring(text), label).toBe(true);
    }
  });
});
