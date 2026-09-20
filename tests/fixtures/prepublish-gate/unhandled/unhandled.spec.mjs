import { test } from 'vitest';

void Promise.reject(new Error('[vitest-worker]: Timeout calling "onTaskUpdate"'));

test('prepublish gate fixture: passes but leaks a rejection', () => {});
