#!/usr/bin/env node
// Runs `hippo mcp` on this process's stdio, so the server and its store stay on this machine.
import { spawnHippo } from './spawn-hippo.mjs';

function fail(err) {
  process.stderr.write(
    `hippo-memory plugin: cannot start the hippo CLI (${err.message}). Install it: npm install -g hippo-memory\n`,
  );
  process.exit(1);
}

try {
  const child = spawnHippo(['mcp'], 'inherit');
  child.on('error', fail);
  child.on('exit', (code) => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (err) {
  fail(err);
}
