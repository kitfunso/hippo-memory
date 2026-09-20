import { test } from 'vitest';

void Promise.reject(new Error('prepublish gate fixture: unhandled rejection'));

test('prepublish gate fixture: passes but leaks a rejection', () => {});
