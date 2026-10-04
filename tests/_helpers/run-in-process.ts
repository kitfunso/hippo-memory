// Runs a CLI verb function in this process and returns what a spawned `hippo` would print plus its exit code,
// so a verb test skips the node start-up and module load a child process pays.
import { format } from 'node:util';
import { vi } from 'vitest';

/** Thrown in place of process.exit so the verb stops where the real process would. */
export class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

export interface InProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/** Captures console and stream writes while `fn` runs; a process.exit(n) ends the run with status n. */
export async function runInProcess(fn: () => void | Promise<void>): Promise<InProcessResult> {
  const out: string[] = [];
  const err: string[] = [];
  const toErr = (...parts: unknown[]): void => { err.push(`${format(...parts)}\n`); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(`${format(...parts)}\n`); }),
    vi.spyOn(console, 'error').mockImplementation(toErr),
    vi.spyOn(console, 'warn').mockImplementation(toErr),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }),
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => { throw new ExitCalled(Number(code ?? 0)); }),
  ];
  let status = 0;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ExitCalled)) throw error;
    status = error.code;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return { stdout: out.join(''), stderr: err.join(''), status };
}
