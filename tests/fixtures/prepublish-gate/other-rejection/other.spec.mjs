import { test } from 'vitest';

void Promise.reject(new Error('a real bug, not the known worker IPC artifact'));

test('prepublish gate fixture: passes but leaks a rejection the gate must not forgive', () => {});
