/** mkdirSync options for a folder under a hippo store, the store root first: owner-only, as an
 * open makes the root, so a log or spool write before the store's first open does not leave a
 * root its open-time mode check warns about. */
export const PRIVATE_DIR = { recursive: true, mode: 0o700 } as const;
