// Holds each test's stores from their first close (tests/_helpers/held-stores.ts) and keeps the holds out of what a test
// sees: a held store is let go, as its last close would leave it, before anything reads, copies, removes, renames or
// overwrites its files, and every hold ends with its test.
import fs, { type PathLike } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { holdStoresOnClose, releaseHeldStores } from './_helpers/held-stores.js';

declare global {
  // node:fs and node:sqlite are one per worker while this file runs once per test file, so each is patched once.
  var hippoHeldStoresPatched: boolean | undefined;
}

// A file descriptor or handle names no path, so it matches no store.
function letGo(...paths: (PathLike | number | FileHandle)[]): void {
  for (const p of paths) releaseHeldStores(p instanceof URL ? fileURLToPath(p) : String(p));
}

if (!globalThis.hippoHeldStoresPatched) {
  globalThis.hippoHeldStoresPatched = true;
  holdStoresOnClose();
  const { rmSync, rmdirSync, unlinkSync, renameSync, writeFileSync, copyFileSync, cpSync, readFileSync } = fs;
  const { rm, rmdir, unlink, rename, writeFile, copyFile, cp, readFile } = fs.promises;
  fs.rmSync = (path, options) => (letGo(path), rmSync(path, options));
  fs.rmdirSync = (path, options) => (letGo(path), rmdirSync(path, options));
  fs.unlinkSync = (path) => (letGo(path), unlinkSync(path));
  fs.renameSync = (from, to) => (letGo(from, to), renameSync(from, to));
  fs.writeFileSync = (file, data, options) => (letGo(file), writeFileSync(file, data, options));
  fs.copyFileSync = (from, to, mode) => (letGo(from, to), copyFileSync(from, to, mode));
  fs.cpSync = (from, to, options) => (letGo(from, to), cpSync(from, to, options));
  // SAFETY: the wrapper hands its arguments to readFileSync as given, so it answers each overload as readFileSync does.
  fs.readFileSync = ((...args: Parameters<typeof readFileSync>) => (
    letGo(args[0]),
    readFileSync(...args)
  )) as typeof readFileSync;
  fs.promises.rm = async (path, options) => (letGo(path), rm(path, options));
  fs.promises.rmdir = async (path, options) => (letGo(path), rmdir(path, options));
  fs.promises.unlink = async (path) => (letGo(path), unlink(path));
  fs.promises.rename = async (from, to) => (letGo(from, to), rename(from, to));
  fs.promises.writeFile = async (file, data, options) => (letGo(file), writeFile(file, data, options));
  fs.promises.copyFile = async (from, to, mode) => (letGo(from, to), copyFile(from, to, mode));
  fs.promises.cp = async (from, to, options) => (letGo(from, to), cp(from, to, options));
  // SAFETY: as readFileSync above.
  fs.promises.readFile = (async (...args: Parameters<typeof readFile>) => (
    letGo(args[0]),
    readFile(...args)
  )) as typeof readFile;
  syncBuiltinESMExports();
}

afterEach(() => releaseHeldStores());
