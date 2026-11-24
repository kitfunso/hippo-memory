import { createHash } from 'node:crypto';
import { MAX_ID_LEN } from '../../../base/util/limits.js';

const PREFIX = 'spool:';

/** `spool:` plus the key; a key too long for an id is hashed, so one key always gives one id. */
export function spoolRequestId(importKey: string): string {
  const id = `${PREFIX}${importKey}`;
  if (id.length <= MAX_ID_LEN) return id;
  return `${PREFIX}${createHash('sha256').update(importKey).digest('hex')}`;
}
