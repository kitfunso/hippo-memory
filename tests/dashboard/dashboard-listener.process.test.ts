// The dashboard's listener: a port it cannot open, the socket deadlines it shares with the API server, and a stop on a signal.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { serve } from '../../src/server.js';
import { scratch, type Scratch } from '../_helpers/compaction-hooks.js';
import { startDashboard } from '../_helpers/dashboard-fixture.js';
import { boundPort } from '../_helpers/listen.js';
import { makeRoot, removeWhenStopped } from '../_helpers/make-root.js';
import { ownStderr } from '../_helpers/own-stderr.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { startNode, type StartedChild } from '../_helpers/started-child.js';
import { initTestStore } from '../_helpers/store-template.js';

const CONNECTIONS_CLI = resolve(__dirname, '..', 'fixtures', 'dashboard-connections-cli.mjs');

const scratches: Scratch[] = [];
const roots: string[] = [];
const holders: Server[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) await new Promise((done) => holder.close(done));
  for (const s of scratches.splice(0)) await removeWhenStopped(s.dir);
  for (const root of roots.splice(0)) await removeWhenStopped(root);
});

/** A scratch project with a store, its own home folder and its own global store. */
function project(): Scratch {
  const s = scratch();
  scratches.push(s);
  initTestStore(s.hippoRoot);
  return s;
}

/** Node cannot send a signal to another process on Windows (a kill there ends it outright), so the fixture raises Ctrl+C's SIGINT itself. */
function deliverStop(child: StartedChild): void {
  if (process.platform === 'win32') child.send('stop\n');
  else process.kill(child.pid, 'SIGTERM');
}

describe('hippo dashboard listener', () => {
  it('prints one line that names the port and what to do, and exits 1, when the port is taken', async () => {
    const holder = createServer();
    holders.push(holder);
    holder.listen(0, '127.0.0.1');
    const port = await boundPort(holder);
    const s = project();

    const run = hippoRun(['dashboard', '--port', String(port)], { cwd: s.proj, env: s.env });

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
    const child = startNode([CONNECTIONS_CLI, reportFile, 'dashboard', '--port', '0'], { cwd: s.proj, env: s.env });
    // The ticket is never on stdout; the banner names the URL file that holds it.
    const [, port, urlFile] = await child.line(
      /Hippo Dashboard running at http:\/\/localhost:(\d+)\/ \(open the URL with its token from (.+)\)/,
      'the dashboard banner',
    );
    const ticket = /\?token=(\S+)/.exec(readFileSync(urlFile!.trim(), 'utf8'))?.[1];
    const ticketUrl = `http://127.0.0.1:${port}/?token=${ticket}`;
    const signIn = await fetch(ticketUrl, { redirect: 'manual' });
    expect(signIn.status).toBe(303);
    expect((await fetch(ticketUrl, { redirect: 'manual' })).status).toBe(401);
    // A read wakes the reader thread, and the reply's kept-alive socket is one the stop has to close.
    const overview = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      headers: { cookie: (signIn.headers.get('set-cookie') ?? '').split(';')[0]! },
    });
    expect(overview.status, await overview.text()).toBe(200);

    deliverStop(child);
    const exit = await child.exited();
    expect({ code: exit.code, signal: exit.signal }, exit.stdout + exit.stderr).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toEqual({ atSignal: 1, atExit: 0 });
    expect(exit.stderr).toMatch(/received SIG(INT|TERM), shutting down/);
    expect(exit.stderr).not.toContain('did not finish within');
  });
});
