// Keeps the holds of tests/_helpers/held-stores.ts out of what a test sees: a held store is let go before anything
// removes or renames it, since Windows refuses both on a file SQLite holds open, and every hold ends with its test.
import fs, { type PathLike } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { releaseHeldStores } from './_helpers/held-stores.js';

declare global {
  // node:fs is one per worker while this file runs once per test file, so the wrap is made once.
  var hippoHeldStoresFsWrapped: boolean | undefined;
}

function letGo(...paths: PathLike[]): void {
  for (const p of paths) releaseHeldStores(p instanceof URL ? fileURLToPath(p) : String(p));
}

if (!globalThis.hippoHeldStoresFsWrapped) {
  globalThis.hippoHeldStoresFsWrapped = true;
  const { rmSync, rmdirSync, unlinkSync, renameSync } = fs;
  const { rm, rmdir, unlink, rename } = fs.promises;
  fs.rmSync = (path, options) => (letGo(path), rmSync(path, options));
  fs.rmdirSync = (path, options) => (letGo(path), rmdirSync(path, options));
  fs.unlinkSync = (path) => (letGo(path), unlinkSync(path));
  fs.renameSync = (from, to) => (letGo(from, to), renameSync(from, to));
  fs.promises.rm = async (path, options) => (letGo(path), rm(path, options));
  fs.promises.rmdir = async (path, options) => (letGo(path), rmdir(path, options));
  fs.promises.unlink = async (path) => (letGo(path), unlink(path));
  fs.promises.rename = async (from, to) => (letGo(from, to), rename(from, to));
  syncBuiltinESMExports();
}

afterEach(() => releaseHeldStores());
