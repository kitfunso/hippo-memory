#!/usr/bin/env node
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  rest[0] === 'ExperimentalWarning' && /SQLite/.test(String(w)) ? undefined : emit.call(process, w, ...rest);
const { runCli } = await import('../dist/cli.js');

runCli();
