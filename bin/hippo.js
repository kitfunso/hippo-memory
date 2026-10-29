#!/usr/bin/env node
// node:sqlite warns once per process, and an agent reads the lines on each hippo call.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  rest[0] === 'ExperimentalWarning' && /SQLite/.test(String(w)) ? undefined : emit.call(process, w, ...rest);
const { runCli } = await import('../dist/cli.js');

runCli();
