import { createServer, type Server } from 'node:http';
import { writePidfile, removePidfile } from './server-detect.js';

// Pinned at module load. Bumped alongside package.json on releases. The
// HTTP /health response uses this; reading package.json synchronously here
// would couple the daemon to its on-disk install path, which we want to
// avoid for tests that mkdtemp a hippoRoot.
const VERSION = '0.35.0';

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export interface ServeOpts {
  hippoRoot: string;
  port?: number;
  host?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Boot the HTTP daemon on host:port and write the pidfile under hippoRoot.
 *
 * Refuses non-loopback hosts at boot (Footgun #3 from the A1 plan): without
 * the A5 v2 auth middleware we have no way to gate remote requests, so we
 * fail fast rather than expose the DB to the network. Task 9 will lift this
 * restriction once Bearer-token validation lands.
 *
 * Use port: 0 in tests to bind to an ephemeral port and read the actual
 * port back via server.address() after listen.
 */
export async function serve(opts: ServeOpts): Promise<ServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? Number(process.env.HIPPO_PORT ?? 6789);

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to bind hippo serve to non-loopback host '${host}' without auth. ` +
      `Remote-host serving requires the A5 v2 auth middleware (Task 9 of the A1 plan). ` +
      `Bind to 127.0.0.1 / ::1 / localhost, or wait for auth support.`,
    );
  }

  const startedAt = new Date().toISOString();

  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({
        ok: true,
        version: VERSION,
        started_at: startedAt,
        pid: process.pid,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server.address() returned unexpected shape');
  }
  const actualPort = address.port;
  const url = `http://${host}:${actualPort}`;

  writePidfile(opts.hippoRoot, { port: actualPort, url });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    removePidfile(opts.hippoRoot);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  // Skip signal handlers under vitest so each test run does not register a
  // stray SIGTERM/SIGINT listener that survives until the runner exits.
  if (!process.env.VITEST) {
    process.once('SIGTERM', () => { void stop(); });
    process.once('SIGINT', () => { void stop(); });
  }

  return { port: actualPort, url, stop };
}
