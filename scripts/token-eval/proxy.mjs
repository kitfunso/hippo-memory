// The G1 request log (prereg 158): a local proxy that records every request body a Claude Code session sends, then forwards it.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';

/** Start a proxy on 127.0.0.1 (port 0 picks a free one) that appends each request body to `logFile`.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} */
export function startLogProxy(logFile, { port = 0, upstream = 'https://api.anthropic.com' } = {}) {
  const target = new URL(upstream);
  const log = (entry) => fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // Headers are never logged: Authorization carries the operator's plan login.
      log({ method: req.method, url: req.url, body: body.toString('utf8') });
      const client = target.protocol === 'http:' ? http : https;
      const prefix = target.pathname.replace(/\/$/, '');
      const up = client.request({ hostname: target.hostname, port: target.port, path: `${prefix}${req.url}`, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
        log({ url: req.url, status: r.statusCode });
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', (err) => {
        log({ url: req.url, error: err.message });
        if (!res.headersSent) res.writeHead(502);
        res.end(err.message);
      });
      up.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}

/** The request bodies in a proxy log; a missing file is a session that sent nothing. */
export function requestBodies(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.body !== undefined).map((e) => e.body);
}
