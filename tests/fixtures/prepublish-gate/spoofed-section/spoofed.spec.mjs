import { test } from 'vitest';

// A test's own output can carry the header the gate searches for, so the earliest match is not vitest's section.
console.error(`--- Unhandled Errors ---

Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
`);

void Promise.reject(new Error('a genuine bug unrelated to worker IPC'));

test('prepublish gate fixture: passes, prints a fake artifact section, then leaks a real error', () => {});
