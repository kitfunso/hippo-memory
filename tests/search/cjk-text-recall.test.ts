// Chinese, Japanese and Korean text is matched like English: the api read behind `hippo recall` owns the contract,
// the CLI rows wire it up, and the sleep pass's conflict check reads the same words.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { remember, retrieve } from '../../src/api/index.js';
import { runCli } from '../../src/cli.js';
import { detectConflicts } from '../../src/domain/consolidate/conflicts.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';

// Each query shares no character pair with `other`, so only `fact` may come back.
const CASES = [
  { lang: 'zh', fact: '数据库连接池的大小必须设置为二十', other: '部署前必须先运行迁移脚本', query: '数据库连接池' },
  {
    lang: 'ja',
    fact: 'データベースの接続プールのサイズは二十に設定する',
    other: 'デプロイの前に移行スクリプトを実行する',
    query: '接続プール',
  },
  {
    lang: 'ko',
    fact: '데이터베이스 연결 풀 크기는 이십으로 설정해야 한다',
    other: '배포 전에 마이그레이션 스크립트를 실행한다',
    query: '연결 풀 크기',
  },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

function apiHome() {
  const home = makeRoot('cjk-api');
  vi.stubEnv('HIPPO_HOME', home);
  return apiCtx(home);
}

describe('CJK remember then recall, through the api', () => {
  it.each(CASES)(
    '$lang: a query finds the memory holding its words, and only that one',
    async ({ fact, other, query }) => {
      const ctx = apiHome();
      await remember(ctx, { content: fact });
      await remember(ctx, { content: other });
      const { results } = await retrieve(ctx, { query, window: { limit: 5 } });
      expect(results.map((r) => r.content)).toEqual([fact]);
    },
  );

  it('a mixed English and Chinese query finds rows holding either word, the row holding both first', async () => {
    const ctx = apiHome();
    const both = 'Postgres 连接池的大小必须设置为二十';
    const english = 'Postgres vacuum runs every night';
    const chinese = '连接池在部署后泄漏';
    for (const content of [both, english, chinese, '部署前必须先运行迁移脚本']) await remember(ctx, { content });
    const { results } = await retrieve(ctx, { query: 'postgres 连接池', window: { limit: 5 } });
    expect(results[0]?.content).toBe(both);
    expect(results.map((r) => r.content).sort()).toEqual([both, english, chinese].sort());
  });
});

// The word splitter once cut every non-ASCII letter into a space, so these had no words at all.
const OTHER_SCRIPTS = [
  { script: 'Cyrillic', fact: 'сервер перезагружается ночью', other: 'база данных хранит заказы', query: 'сервер' },
  {
    script: 'Greek',
    fact: 'ο διακομιστής επανεκκινείται τη νύχτα',
    other: 'η βάση δεδομένων κρατά παραγγελίες',
    query: 'διακομιστής',
  },
  { script: 'Arabic', fact: 'الخادم يعيد التشغيل كل ليلة', other: 'قاعدة البيانات تحفظ الطلبات', query: 'الخادم' },
  { script: 'Hebrew', fact: 'השרת מופעל מחדש בלילה', other: 'מסד הנתונים שומר הזמנות', query: 'השרת' },
  { script: 'Devanagari', fact: 'सर्वर हर रात फिर से चालू होता है', other: 'डेटाबेस ऑर्डर सहेजता है', query: 'सर्वर' },
  { script: 'accented Latin', fact: 'the café opens at nine', other: 'the cafeteria closes at noon', query: 'café' },
];

describe('other scripts, through the api', () => {
  it.each(OTHER_SCRIPTS)('$script: one word finds the memory holding it, and only that one', async (c) => {
    const ctx = apiHome();
    await remember(ctx, { content: c.fact });
    await remember(ctx, { content: c.other });
    const { results } = await retrieve(ctx, { query: c.query, window: { limit: 5 } });
    expect(results.map((r) => r.content)).toEqual([c.fact]);
  });
});

/** `hippo <args>` run in this process from `cwd`; a non-zero exit fails the test. */
async function hippo(cwd: string, ...args: string[]): Promise<string> {
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.chdir(saved);
  }
}

describe('CJK remember then recall, through the CLI', () => {
  it.each(CASES)('$lang: hippo recall prints the memory holding the words', async ({ fact, other, query }) => {
    const home = makeRoot('cjk-cli', { init: false });
    vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo(home, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo(home, 'remember', fact);
    await hippo(home, 'remember', other);
    const out = await hippo(home, 'recall', query);
    expect(out).toContain(fact);
    expect(out).not.toContain(other);
  });
});

describe('a one-letter CJK query, through the CLI', () => {
  it('finds the memory holding the letter inside a longer word', async () => {
    const home = makeRoot('cjk-cli-one', { init: false });
    vi.stubEnv('HIPPO_HOME', join(home, 'global-hippo'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    await hippo(home, 'init', '--no-hooks', '--no-schedule', '--no-learn');
    await hippo(home, 'remember', '연결 풀은 이십으로 설정한다');
    await hippo(home, 'remember', '배포 전에 스크립트를 실행한다');
    const out = await hippo(home, 'recall', '풀');
    expect(out).toContain('연결 풀은 이십으로 설정한다');
    expect(out).not.toContain('배포 전에 스크립트를 실행한다');
  });
});

describe('CJK conflicts', () => {
  it('two memories that disagree about the same Chinese words are a conflict', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const rows = ['always 启用数据库连接池', 'never 启用数据库连接池'].map((text, k) => ({
      ...createMemory(text, {}),
      id: `c${k}`,
      created: now.toISOString(),
      lastRetrieved: now.toISOString(),
    }));
    const got = await detectConflicts(rows, now, { strength: PRODUCTION_STRENGTH });
    expect(got.map((c) => [c.memoryAId, c.memoryBId])).toEqual([['c0', 'c1']]);
  });
});
