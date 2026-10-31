#!/usr/bin/env node
// Z0 smoke point 1 (prereg G1): the runner's request-log proxy on a fixed port, for hand-run sessions.
// Usage: node benchmarks/token-eval/smoke/log-proxy.mjs <port> <log.jsonl>; then set ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
import { startLogProxy } from '../../../scripts/token-eval/proxy.mjs';

const [port, logFile] = process.argv.slice(2);
if (!port || !logFile) throw new Error('usage: log-proxy.mjs <port> <log.jsonl>');
const proxy = await startLogProxy(logFile, { port: Number(port) });
process.stdout.write(`log proxy on ${proxy.url}, bodies to ${logFile}\n`);
