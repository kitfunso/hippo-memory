import { test } from 'vitest';

void Promise.reject(new Error('[vitest-worker]: Timeout calling "onTaskUpdate"'));
void Promise.reject('a rejected string, which vitest banners without an "Error:" prefix');

test('prepublish gate fixture: passes, leaks the artifact plus one error the matcher cannot see', () => {});
