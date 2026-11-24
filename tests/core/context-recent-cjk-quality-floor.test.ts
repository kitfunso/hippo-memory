import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { isContentWorthStoring } from '../../src/base/memory/memory-quality.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { contextGet } from '../../src/api/index.js';
import { apiCtx, cwdProject } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function tmpHome() {
  const home = makeRoot('df3-cjk');
  const globalTmp = makeRoot('df3-cjk-global', { init: false });
  vi.stubEnv('HIPPO_HOME', globalTmp);
  return {
    home,
    restore: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function seed(home: string, content: string, opts: { created?: string } = {}) {
  const entry = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Episodic,
    tenantId: 'default',
  });
  if (opts.created) entry.created = opts.created;
  writeEntry(home, entry);
  return entry;
}

const CJK_SENTENCE = 'データベース接続がタイムアウトしたときは再試行の間隔を二倍にする';

describe('CJK-aware substantiveWordCount (src/store/audit.ts)', () => {
  it('(a) a substantive CJK sentence passes isContentWorthStoring', () => {
    expect(isContentWorthStoring(CJK_SENTENCE)).toBe(true);
  });

  it('(a) a substantive CJK sentence is returned via includeRecent', async () => {
    const { home, restore } = tmpHome();
    try {
      const ctx: FullContext = apiCtx(home, 'default', { subject: 'cli', role: 'admin' });
      seed(home, CJK_SENTENCE, { created: '2026-08-20T10:00:00.000Z' });

      const result = await contextGet(ctx, {
        currentProject: cwdProject(),
        pinnedOnly: true,
        includeRecent: 1,
        budget: 500,
      });
      const contents = result.entries.map((e) => e.entry.content);

      expect(contents).toContain(CJK_SENTENCE);
    } finally {
      restore();
    }
  });

  it('(b) a genuinely junk short CJK token is still rejected', () => {
    expect(isContentWorthStoring('設定変更')).toBe(false);
    expect(isContentWorthStoring('了解')).toBe(false);
  });

  it('(c) existing latin classification is unchanged (before/after parity)', () => {
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

  it('kana punctuation is not substantive: a punctuation-only string stays rejected', () => {
    expect(isContentWorthStoring('・'.repeat(10))).toBe(false);
    expect(isContentWorthStoring('ー'.repeat(10))).toBe(false);
  });

  it('mixed latin+CJK tokens keep their prior count: previously-accepted content is not newly rejected', () => {
    expect(isContentWorthStoring('UI層 DB層 QA層')).toBe(true);
  });

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
