// Stubs that let an entry point wire its process handlers inside a test worker without ending or muting the worker.
import type { EventEmitter } from 'node:events';
import { vi, type MockInstance } from 'vitest';

export type Listener = Parameters<typeof process.on>[1];

/** Records what `on` and `once` register on `target`, by event name, instead of attaching it. */
export function recordListeners(target: EventEmitter, ...methods: Array<'on' | 'once'>): Map<string, Listener[]> {
  const listeners = new Map<string, Listener[]>();
  for (const method of methods) {
    vi.spyOn(target, method).mockImplementation((event: string | symbol, listener: Listener) => {
      listeners.set(String(event), [...(listeners.get(String(event)) ?? []), listener]);
      return target;
    });
  }
  return listeners;
}

/** Calls every listener recorded for `event` with `args`. */
export function fire(listeners: Map<string, Listener[]>, event: string, ...args: Parameters<Listener>): void {
  for (const listener of listeners.get(event) ?? []) listener(...args);
}

/** process.exit returning instead of exiting, so the code after it runs and the call can be asserted. */
export function stubExit(): MockInstance {
  // SAFETY: the stub returns instead of exiting; `never` only satisfies the exit signature.
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

/** Swallows writes to `stream` into the returned list, and still calls the drain callback a flush waits on. */
export function captureWrites(stream: NodeJS.WriteStream): string[] {
  const written: string[] = [];
  vi.spyOn(stream, 'write').mockImplementation(
    (chunk: string | Uint8Array, ...rest: Array<BufferEncoding | ((err?: Error | null) => void) | undefined>) => {
      if (chunk.length > 0) written.push(String(chunk));
      const done = rest.at(-1);
      if (done instanceof Function) done();
      return true;
    },
  );
  return written;
}
