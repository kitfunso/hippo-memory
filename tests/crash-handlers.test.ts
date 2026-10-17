// The handlers run here with process.exit, process.kill and the listener registration stubbed, so no test ends the worker.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { exitAfterFlush, installCrashHandlers, installSignalHandlers } from '../src/util/crash-handlers.js';
import { captureWrites, fire, recordListeners, stubExit, type Listener } from './_helpers/process-stubs.js';

let listeners: Map<string, Listener[]>;
let exit: MockInstance;
let kill: MockInstance;
let stderr: string[];
let priorExitCode: typeof process.exitCode;

function logged(): string {
  return stderr.join('');
}

beforeEach(() => {
  priorExitCode = process.exitCode;
  listeners = recordListeners(process, 'on', 'once');
  exit = stubExit();
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  stderr = captureWrites(process.stderr);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = priorExitCode;
});

describe('exitAfterFlush', () => {
  it('sets the exit code at once and exits with it after both streams drain', async () => {
    exitAfterFlush(3);
    expect(process.exitCode).toBe(3);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('installSignalHandlers', () => {
  it('runs the shutdown once on SIGTERM, ignores a later SIGINT, and exits 0', async () => {
    const run = vi.fn();
    installSignalHandlers('hippo test', { run, boundMs: 5_000 });
    expect(listeners.get('SIGTERM')).toHaveLength(1);
    expect(listeners.get('SIGINT')).toHaveLength(1);

    fire(listeners, 'SIGTERM');
    fire(listeners, 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(run).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('received SIGTERM, shutting down');
    expect(logged()).not.toContain('received SIGINT');
  });

  it('exits 1 and logs the cause when the shutdown throws', async () => {
    installSignalHandlers('hippo test', { run: () => { throw new Error('close failed'); }, boundMs: 5_000 });
    fire(listeners, 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(logged()).toContain('hippo test shutdown after SIGINT failed: close failed');
  });

  it('kills the process when the shutdown outlives its bound, and never exits through the normal path', async () => {
    installSignalHandlers('hippo test', { run: () => new Promise<void>(() => {}), boundMs: 10 });
    fire(listeners, 'SIGTERM');
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL'));
    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(logged()).toContain('hippo test shutdown after SIGTERM did not finish within 10 ms; ending the process without it');
  });
});

describe('installCrashHandlers', () => {
  it('without a shutdown, logs an uncaught throw and exits 1, and a second throw only logs', async () => {
    installCrashHandlers('hippo test');
    fire(listeners, 'uncaughtException', new Error('first boom'));
    fire(listeners, 'uncaughtException', new Error('second boom'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('hippo test uncaught exception: first boom');
    expect(logged()).toContain('hippo test uncaught exception: second boom');
  });

  it('with a shutdown, runs it once after an unhandled rejection and exits 1', async () => {
    const run = vi.fn();
    installCrashHandlers('hippo test', { run, boundMs: 5_000 });
    fire(listeners, 'unhandledRejection', new Error('lost promise'));
    fire(listeners, 'unhandledRejection', new Error('another'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('hippo test unhandled rejection: lost promise');
  });
});
