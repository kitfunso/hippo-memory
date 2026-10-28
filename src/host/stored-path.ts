// Finds the raw path a stored path names: each stored part is matched against the stored form of the entries
// beside it, and a tagged marker names its raw part, so one entry matches.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { storedSource } from '../base/util/secret-detect.js';
import { ignoringCodes, PATH_UNREADABLE } from '../base/util/expected-errors.js';

/** The raw path on this disk whose stored form is `stored`, or null when no entry matches. */
export function resolveStoredPath(stored: string): string | null {
  if (!stored.includes('[REDACTED')) return stored;
  const parts = stored.split('/');
  let at = parts[0] === '' ? '/' : `${parts[0]}/`;
  for (const part of parts.slice(1)) {
    if (part === '') continue;
    if (!part.includes('[REDACTED')) {
      at = path.join(at, part);
      continue;
    }
    const dir = at;
    const names = ignoringCodes(PATH_UNREADABLE, () => fs.readdirSync(dir)) ?? [];
    const raw = names.find((name) => storedSource(name) === part);
    if (raw === undefined) return null;
    at = path.join(at, raw);
  }
  return at;
}
