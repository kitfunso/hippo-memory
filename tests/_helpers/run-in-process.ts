// Runs a CLI verb function in this process and returns what a spawned `hippo` would print plus its exit code,
// so a verb test skips the node start-up and module load a child process pays.
import { format } from 'node:util';
import { vi } from 'vitest';
import { CliExit } from '../../src/cli/exit.js';

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

/** Captures console and stream writes while `fn` runs; the first process.exit(n) or thrown CliExit(n) ends the run with status n. */
export async function runInProcess(fn: () => void | Promise<void>): Promise<InProcessResult> {
  const out: string[] = [];
  const err: string[] = [];
  let exited: ExitCalled | undefined;
  // A caller that catches the throw (runCli does) runs on, so output after the first exit is dropped as the real process would.
  const keep = (sink: string[], text: string): void => { if (!exited) sink.push(text); };
  const toErr = (...parts: unknown[]): void => { keep(err, `${format(...parts)}\n`); };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { keep(out, `${format(...parts)}\n`); }),
    vi.spyOn(console, 'error').mockImplementation(toErr),
    vi.spyOn(console, 'warn').mockImplementation(toErr),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { keep(out, String(chunk)); return true; }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { keep(err, String(chunk)); return true; }),
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => { throw (exited ??= new ExitCalled(Number(code ?? 0))); }),
  ];
  try {
    await fn();
  } catch (error) {
    // A verb called without runCli stops by throwing; the entry would exit with that code.
    if (error instanceof CliExit) exited ??= new ExitCalled(error.code);
    if (!exited) throw error;
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return { stdout: out.join(''), stderr: err.join(''), status: exited?.code ?? 0 };
}
