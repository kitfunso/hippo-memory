import { test } from 'vitest';

void Promise.reject(new Error('prepublish gate fixture: unhandled rejection'));

test.skip('prepublish gate fixture: skipped, so nothing actually ran', () => {});
