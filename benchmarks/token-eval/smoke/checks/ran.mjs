#!/usr/bin/env node
// Smoke lesson checker: pass when any shell command the agent ran holds the first arg, else fail.
import * as fs from 'node:fs';

const needle = process.argv[2];
if (!needle) process.exit(2);
const commands = JSON.parse(fs.readFileSync(process.env.Z0_COMMANDS, 'utf8'));
process.exit(commands.some((c) => String(c).includes(needle)) ? 0 : 1);
