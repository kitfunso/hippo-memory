// Node below 24 prints its own SQLite notice on stderr, with a pid that differs per spawn, so an exact stderr match takes it out first.
const SQLITE_WARNING = /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\r?\n\(Use `node --trace-warnings[^\n]*(?:\r?\n)?/g;

/** The stderr hippo wrote itself, without the runtime's SQLite notice. */
export function ownStderr(text: string): string {
  return text.replace(SQLITE_WARNING, '');
}
