import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Resolves with the port a server bound (pass port 0 to let the OS pick); rejects on a listen error instead of hanging. */
export function boundPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', reject);
      // SAFETY: these tests only bind TCP ports, never pipes, so address() is AddressInfo once listening.
      resolve((server.address() as AddressInfo).port);
    };
    if (server.listening) {
      onListening();
      return;
    }
    server.once('error', reject);
    server.once('listening', onListening);
  });
}

/** Makes every connection the server accepts report `address` as its peer, so a loopback test can play a remote client. */
export function presentConnectionsAsRemote(server: Server, address = '203.0.113.7'): void {
  server.prependListener('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: address, configurable: true });
  });
}
