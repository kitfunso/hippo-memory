import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { ConflictError } from '../../src/base/errors/api-errors.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { supersedeNow } from '../_helpers/supersede-now.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

let root: string;
beforeEach(() => {
  root = makeRoot('store-supersede-conflict');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('store supersede', () => {
  it('refuses a second supersede of one row and keeps the first successor', async () => {
    const ctx = apiCtx(root, 'default', { subject: 'cli', role: 'admin' });
    const old = createMemory('the deploy runs on Tuesdays', { tenantId: 'default' });
    writeEntry(root, old);

    const first = await supersedeNow(ctx, old.id, 'the deploy runs on Wednesdays');
    await expect(supersedeNow(ctx, old.id, 'the deploy runs on Thursdays')).rejects.toThrow(ConflictError);

    expect(readEntry(root, old.id, 'default')?.supersededBy).toBe(first);
  });
});
