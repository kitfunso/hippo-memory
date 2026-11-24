import { resolve } from 'node:path';
import { staleDependencies } from './_build-freshness.js';

export function setup(): void {
  const drift = staleDependencies(resolve(import.meta.dirname, '..'));
  if (drift.length === 0) return;
  throw new Error(
    `node_modules does not match package-lock.json (${drift.join('; ')}). Run \`npm ci\`, or link node_modules to an install of this lockfile.`,
  );
}
