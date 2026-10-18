### Fixed

- **`serve().stop()` settles in a process with nothing else open.** Once a server had answered 32 responses, its stop waited on the background WAL checkpoint thread without holding the process open, so Node ended the process inside `await stop()`: code after it never ran and the held connection never closed. The stop now holds the process until that thread has exited.
