#!/usr/bin/env node
import { startLogProxy } from '../../../scripts/token-eval/proxy.mjs';

const [port, logFile] = process.argv.slice(2);
if (!port || !logFile) throw new Error('usage: log-proxy.mjs <port> <log.jsonl>');
const proxy = await startLogProxy(logFile, { port: Number(port) });
process.stdout.write(`log proxy on ${proxy.url}, bodies to ${logFile}\n`);
