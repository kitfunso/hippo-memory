// Preloaded on Windows only: baseAdapter.ts resolves `new URL(".", import.meta.url).pathname`, which is "/C:/..." here,
// so path.resolve gives "C:\C:\..."; dropping that one slash yields the file POSIX reads, and no other path changes.
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const resolve = path.resolve;
path.resolve = (...parts) => resolve(...parts.map((p) => (typeof p === 'string' && /^\/[A-Za-z]:\//.test(p) ? p.slice(1) : p)));
syncBuiltinESMExports();
