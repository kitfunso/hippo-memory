// A session id becomes a folder name or a word in a command an agent runs, so only word characters and hyphens pass.
export const SESSION_ID_RE = /^[\w-]+$/;
