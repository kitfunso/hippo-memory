// The key a `hippo serve` hands to the CLI and hooks on its own machine. Each start writes a fresh secret next to the
// pidfile, in a file only the user can read; reading that file, never a socket address, is what proves a caller local.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envApiKey } from '../../base/util/env.js';
import { errorCode, errorFields, log } from '../../base/util/log.js';
import { writeFileAtomic } from '../../host/atomic-write.js';

const KEY_FILE = 'server.key';
// Its own prefix, so the token never reaches an auth resolver or the API-key table.
const KEY_PREFIX = 'hl_';
const KEY_BYTES = 32;
// Owner read and write only: any other account on the machine must send a key of its own.
const KEY_FILE_MODE = 0o600;
/** The audit actor of a request the local key signs, as the CLI on this machine has always been named. */
export const LOCAL_KEY_SUBJECT = 'localhost:cli';

// One server per store (the pidfile lock), so a store folder names its server's key; only a digest is held.
const issued = new Map<string, Buffer>();

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Where the server for `hippoRoot` keeps its local key. */
export function localKeyPath(hippoRoot: string): string {
  return join(hippoRoot, KEY_FILE);
}

/** The local key's secret, or undefined when no server has written one; an unreadable file logs a warn. */
export function readLocalKey(hippoRoot: string): string | undefined {
  const path = localKeyPath(hippoRoot);
  try {
    const key = readFileSync(path, 'utf8').trim();
    return key.length > 0 ? key : undefined;
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      log.warn('the hippo serve key file could not be read', { path, ...errorFields(err) });
    }
    return undefined;
  }
}

/** The key a CLI or hook on this machine sends to the server for `hippoRoot`: HIPPO_API_KEY, else the local key. */
export function callerKey(hippoRoot: string): string | undefined {
  return envApiKey() ?? readLocalKey(hippoRoot);
}

/** Writes a fresh local key for the server on `hippoRoot`, so the key of any earlier run stops working. */
export function issueLocalKey(hippoRoot: string): void {
  const token = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
  const path = localKeyPath(hippoRoot);
  writeFileAtomic(path, `${token}\n`, { mode: KEY_FILE_MODE });
  // A file left by an older run keeps its own mode through the rename.
  chmodSync(path, KEY_FILE_MODE);
  issued.set(hippoRoot, digest(token));
}

/** True when `token` is the local key the server on `hippoRoot` issued; compared in constant time. */
export function isLocalKey(hippoRoot: string, token: string): boolean {
  const held = issued.get(hippoRoot);
  return held !== undefined && token.startsWith(KEY_PREFIX) && timingSafeEqual(held, digest(token));
}
