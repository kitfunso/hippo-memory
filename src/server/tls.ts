// The serve() listener: node:https when a certificate is given, else node:http, which a non-loopback bind must opt
// into.
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

/** serve() refused a non-loopback bind without TLS: every key and memory would cross the network as plain text. */
export class CleartextBindError extends Error {
  constructor(readonly host: string) {
    super(
      `hippo serve: refusing to listen on ${host} without TLS, since API keys and memory text would travel in ` +
      `cleartext. ` +
        'Pass --tls-cert and --tls-key (or set HIPPO_TLS_CERT and HIPPO_TLS_KEY) to serve HTTPS. If a ' +
        'TLS-terminating ' +
        'proxy sits in front, ' +
        'start with --allow-cleartext, set HIPPO_ALLOW_CLEARTEXT=1, or pass allowCleartext: true to serve().',
    );
    this.name = 'CleartextBindError';
  }
}

/**
 * Throws CleartextBindError for a non-loopback bind without TLS unless the operator allowed cleartext, which is then
 * said once at boot.
 */
export function assertTlsOrCleartextAllowed(
  host: string,
  tls: ServeOpts['tls'],
  loopbackHosts: ReadonlySet<string>,
  allowCleartext: boolean,
): void {
  if (tls || loopbackHosts.has(host)) return;
  if (!allowCleartext) throw new CleartextBindError(host);
  log.warn(
    `serve: listening on ${host} without TLS, as allowed; API keys and memory text are cleartext until the proxy in ` +
    `front adds TLS.`,
  );
}
