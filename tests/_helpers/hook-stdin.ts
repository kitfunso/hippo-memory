// Hands an in-process hook verb the stdin a hook host would pipe, so a test drives the real handler instead of its inner function.
import { PassThrough } from 'node:stream';

/** Runs `fn` with process.stdin replaced by a stream that carries `text` (nothing when undefined) and then ends. */
export async function withHookStdin<T>(text: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdin = new PassThrough();
  stdin.end(text);
  Object.defineProperty(process, 'stdin', { configurable: true, get: () => stdin });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'stdin', original);
  }
}
