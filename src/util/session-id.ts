import { MAX_ID_LEN } from './limits.js';

// A session id becomes a folder name or a word in a command an agent runs, so only word characters and hyphens pass.
export const SESSION_ID_RE = /^[\w-]+$/;

/** An id a pointer may print in a glued `--id=<id>` flag, where even a leading `--` reads as a value. */
export const isPointerSafeId = (id: string): boolean => id.length <= MAX_ID_LEN && SESSION_ID_RE.test(id);
