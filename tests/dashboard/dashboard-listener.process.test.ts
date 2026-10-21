// The dashboard's listener: a port it cannot open, the socket deadlines it shares with the API server, and a stop on a signal.
import { afterEach, describe, expect, it, onTestFailed } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { serve } from '../src/server.js';
import { removeScratch, scratch, type Scratch } from './_helpers/compaction-hooks.js';
import { sessionCookie, startDashboard } from './_helpers/dashboard-fixture.js';
import { boundPort } from './_helpers/listen.js';
import { makeRoot } from './_helpers/make-root.js';
import { ownStderr } from './_helpers/own-stderr.js';
import { hippoRun } from './_helpers/spawn-hippo.js';
import { initTestStore } from './_helpers/store-template.js';

const CONNECTIONS_CLI = resolve(__dirname, 'fixtures', 'dashboard-connections-cli.mjs');

const scratches: Scratch[] = [];
const roots: string[] = [];
const holders: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = new Promise((done) => child.once('exit', done));
    child.kill('SIGKILL');
    await gone;
  }
  for (const holder of holders.splice(0)) await new Promise((done) => holder.close(done));
  for (const s of scratches.splice(0)) removeScratch(s);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A scratch project with a store, its own home folder and its own global store. */
function project(): Scratch {
  const s = scratch();
  scratches.push(s);
  initTestStore(s.hippoRoot);
  return s;
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Watched {
  readonly stderr: () => string;
  readonly output: () => string;
  /** Settles with the match once stdout holds `pattern`; fails when the child ends first. */
  readonly printed: (pattern: RegExp) => Promise<RegExpExecArray>;
  readonly exited: Promise<Exit>;
}

function watch(child: ChildProcessWithoutNullStreams): Watched {
  let stdout = '';
  let stderr = '';
  const waiting: Array<() => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (const check of waiting) check();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const output = (): string => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  // A wait that only the runner's timeout ends would otherwise leave no evidence of what the child did.
  onTestFailed(() => {
    console.error(output());
  });
  // 'close' fires after stdio drains; 'exit' can beat the last stderr chunk.
  const exited = new Promise<Exit>((done) => child.once('close', (code, signal) => done({ code, signal })));
  const printed = (pattern: RegExp): Promise<RegExpExecArray> =>
    new Promise((done, fail) => {
      void exited.then(({ code, signal }) =>
        fail(new Error(`the child ended (code ${code}, signal ${signal}) before the dashboard printed ${pattern}`)),
      );
      const check = (): void => {
        const match = pattern.exec(stdout);
        if (match !== null) done(match);
      };
      waiting.push(check);
      check();
    });
  return { stderr: () => stderr, output, printed, exited };
}

/** Node cannot send a signal to another process on Windows (a kill there ends it outright), so the fixture raises Ctrl+C's SIGINT itself. */
function deliverStop(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32') child.stdin.write('stop\n');
  else child.kill('SIGTERM');
}

describe('hippo dashboard listener', () => {
  it('prints one line that names the port and what to do, and exits 1, when the port is taken', async () => {
    const holder = createServer();
    holders.push(holder);
    holder.listen(0, '127.0.0.1');
    const port = await boundPort(holder);
    const s = project();

    const run = hippoRun(['dashboard', '--port', String(port)], { cwd: s.proj, env: s.env, timeout: 60_000 });

    expect(ownStderr(run.stderr)).toBe(
      `hippo dashboard: port ${port} is already in use. Stop the program that holds it, or choose another port with --port <number>.\n`,
    );
    expect(run.stdout).toBe('');
    expect(run.status).toBe(1);
  });

  it("listens under the API server's socket deadlines", async () => {
    const root = makeRoot('dashboard-listener');
    roots.push(root);
    const api = await serve({ hippoRoot: root, port: 0 });
    const dashboard = await startDashboard(root);
    try {
      if (!api.server) throw new Error('serve() returned no server');
      const { keepAliveTimeout, headersTimeout, requestTimeout } = api.server;
      expect(dashboard.server).toMatchObject({ keepAliveTimeout, headersTimeout, requestTimeout });
    } finally {
      await dashboard.close();
      await api.stop();
    }
  });

  it('closes the listener and the snapshot store, then exits 0, on the stop signal this platform can deliver', async () => {
    const s = project();
    const reportFile = join(s.dir, 'connections.json');
    const child = spawn(process.execPath, [CONNECTIONS_CLI, reportFile, 'dashboard', '--port', '0'], {
      cwd: s.proj,
      env: s.env,
    });
    children.push(child);
    const watched = watch(child);
    // The token is never on stdout; the banner names the URL file that holds it.
    const [, port, urlFile] = await watched.printed(
      /Hippo Dashboard running at http:\/\/localhost:(\d+)\/ \(open the URL with its token from (.+)\)/,
    );
    const token = /\?token=(\S+)/.exec(readFileSync(urlFile!.trim(), 'utf8'))?.[1];
    // A read wakes the reader thread, and the reply's kept-alive socket is one the stop has to close.
    const overview = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      headers: { cookie: sessionCookie(Number(port), token ?? '') },
    });
    expect(overview.status, await overview.text()).toBe(200);

    deliverStop(child);
    // `hippo serve` allows a signal shutdown 15 s, inside the test timeout; a child that never ends fails there.
    expect(await watched.exited, watched.output()).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toEqual({ atSignal: 1, atExit: 0 });
    expect(watched.stderr()).toMatch(/received SIG(INT|TERM), shutting down/);
    expect(watched.stderr()).not.toContain('did not finish within');
  });
});
