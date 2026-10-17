// Runs a CLI verb function in this process and returns what a spawned `hippo` would print plus its exit code,
// so a verb test skips the node start-up and module load a child process pays.
import { format } from 'node:util';
import { vi } from 'vitest';
import { CliExit } from '../../src/cli/exit.js';
import { _resetProjectIdentityCacheForTests } from '../../src/core/project-identity.js';

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
  // Node's write(chunk, cb) and write(chunk, encoding, cb): the drain callback fires at once, as on a drained stream.
  const drained = (rest: unknown[]): void => {
    for (const arg of rest) if (arg instanceof Function) arg();
  };
  const priorExitCode = process.exitCode;
  const spies = [
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { keep(out, `${format(...parts)}\n`); }),
    vi.spyOn(console, 'error').mockImplementation(toErr),
    vi.spyOn(console, 'warn').mockImplementation(toErr),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => { keep(out, String(chunk)); drained(rest); return true; }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => { keep(err, String(chunk)); drained(rest); return true; }),
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => { throw (exited ??= new ExitCalled(Number(code ?? 0))); }),
  ];
  // A spawned hippo starts with no cached project, so one test's project cannot leak into the next.
  _resetProjectIdentityCacheForTests();
  try {
    await fn();
  } catch (error) {
    // A verb called without runCli stops by throwing; the entry would exit with that code.
    if (error instanceof CliExit) exited ??= new ExitCalled(error.code);
    if (!exited) throw error;
  } finally {
    for (const spy of spies) spy.mockRestore();
    // Only an exit restores it: a verb that sets exitCode and returns leaves it for the caller to read.
    if (exited) process.exitCode = priorExitCode;
  }
  return { stdout: out.join(''), stderr: err.join(''), status: exited?.code ?? 0 };
}
