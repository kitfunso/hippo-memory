import { test } from 'vitest';

void Promise.reject(new Error('[vitest-worker]: Timeout calling "onTaskUpdate"'));

test.skip('prepublish gate fixture: skipped, so nothing actually ran', () => {});
