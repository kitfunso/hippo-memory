import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { remember } from '../src/api/index.js';
import { configOf } from '../src/api/config-of.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { makeRoot } from './_helpers/make-root.js';

describe('api config from the Context', () => {
  it('uses ctx.config and does not read config.json', async () => {
    const root = makeRoot('ctx-config');
    const base = apiCtx(root);
    const ctxConfig = { ...loadConfig(root), defaultHalfLifeDays: 11 };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ defaultHalfLifeDays: 99 }));
    const ctx = { ...base, config: ctxConfig };
    expect(configOf(ctx).defaultHalfLifeDays).toBe(11);
    const result = await remember(ctx, { content: 'ctx config carries the half-life' });
    expect(result.halfLifeDays).toBe(11);
    expect(configOf(base).defaultHalfLifeDays).toBe(99);
  });
});
