// The serve() listener: node:https when a certificate is given, else node:http and a boot warning off loopback.
import { createServer as createHttpServer, type RequestListener, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { errorMessage, log } from '../util/log.js';
import type { ServeOpts } from './types.js';

export function createListener(tls: ServeOpts['tls'], onRequest: RequestListener): Server {
  if (!tls) return createHttpServer(onRequest);
  try {
    // Explicit so the floor does not move with the runtime's default.
    return createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, onRequest);
  } catch (err) {
    // OpenSSL's own text names no file, so the operator would not know which input was refused.
    throw new Error(`hippo serve: the TLS certificate or key was refused: ${errorMessage(err)}`, { cause: err });
  }
}

/** Said once at boot: a non-loopback bind without TLS sends every key and memory over the network as plain text. */
export function warnIfCleartext(host: string, tls: ServeOpts['tls'], loopbackHosts: ReadonlySet<string>): void {
  if (tls || loopbackHosts.has(host)) return;
  log.warn(
    `serve: listening on ${host} without TLS, so API keys and memory text travel in cleartext unless a TLS-terminating proxy sits in front. ` +
      'To serve HTTPS directly, pass --tls-cert and --tls-key (or set HIPPO_TLS_CERT and HIPPO_TLS_KEY).',
  );
}
