// `hippo serve` in process on port 0: process.on/once and exit are stubbed, so its SIGTERM handler stops it without ending the worker.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { handleServe } from '../../src/surface/cli/serve.js';
import { callMatching, fire, recordListeners, stubExit, type Listener } from '../_helpers/process-stubs.js';
import { makeRoot } from '../_helpers/make-root.js';

interface Pidfile {
  readonly url: string;
}

let dir: string;
let listeners: Map<string, Listener[]>;
let exit: MockInstance;
let printed: string[];
let log: MockInstance;

beforeEach(() => {
  dir = makeRoot('serve-cmd');
  listeners = recordListeners(process, 'on', 'once');
  exit = stubExit();
  printed = [];
  log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    printed.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('hippo serve, in process', () => {
  it('prints its start lines, answers /health, writes the pidfile, and on SIGTERM closes and removes it', async () => {
    void handleServe({ hippoRoot: dir, tenantId: 'default', args: [], flags: { port: '0' } });
    await callMatching(log, (line) => line === 'press Ctrl+C to stop', { what: 'the last serve start line' });

    const started = /listening on (\S+) \(pid (\d+)\)/.exec(printed[0]);
    expect(started?.[2]).toBe(String(process.pid));
    const url = started?.[1] ?? '';
    expect(printed[1]).toContain('API key');
    expect(printed[2]).toBe(`pidfile: ${join(dir, 'server.pid')}`);
    const pidfile: Pidfile = JSON.parse(readFileSync(join(dir, 'server.pid'), 'utf8'));
    expect(pidfile.url).toBe(url);

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    const body: { ok: boolean } = await health.json();
    expect(body.ok).toBe(true);

    fire(listeners, 'SIGTERM');
    await callMatching(exit, (code) => code === 0, { what: 'process.exit(0) after SIGTERM' });
    expect(existsSync(join(dir, 'server.pid'))).toBe(false);
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
