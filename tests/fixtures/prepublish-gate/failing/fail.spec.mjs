import { test } from 'vitest';

test('prepublish gate fixture: fails on purpose', () => {
  throw new Error('red on purpose');
});
