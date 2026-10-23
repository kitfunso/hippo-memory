// The agent-memory adapters' disk reads: size, binary and failure checks live here, behind the AgentFiles port.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentFiles, DirListing, TextFile } from '../base/util/agent-files.js';
import { errorMessage } from '../base/util/log.js';
import { isFile, realpathOrResolve } from '../host/real-path.js';

const MAX_ITEM_BYTES = 256 * 1024;
const MAX_DEPTH = 8;

function readText(file: string): TextFile {
  try {
    // O_NONBLOCK opens a FIFO at once, for the file check to turn away; Windows has no such flag and the OR adds
    // nothing.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      return readOpenTextFile(file, fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, reason: `${file}: ${errorMessage(err)}` };
  }
}

/** The checks and the read on one descriptor, so the file measured is the file read. */
function readOpenTextFile(file: string, fd: number): TextFile {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) return { ok: false, reason: `${file}: not a file` };
  // A tool rewriting a file truncates it first; read as holding no notes, every row would be set aside.
  if (stat.size === 0) return { ok: false, reason: `${file}: empty` };
  if (stat.size > MAX_ITEM_BYTES) return { ok: false, reason: `${file}: over ${MAX_ITEM_BYTES} bytes` };
  const buf = fs.readFileSync(fd);
  if (buf.includes(0)) return { ok: false, reason: `${file}: not text` };
  return { ok: true, text: buf.toString('utf8'), mtimeMs: stat.mtimeMs };
}

function listFiles(dir: string, opts: { readonly recursive: boolean }): DirListing {
  if (!fs.existsSync(dir)) return { status: 'missing' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { status: 'unreadable', reason: `${dir}: not a folder` };
    const files: string[] = [];
    walk(dir, '', opts.recursive ? MAX_DEPTH : 0, files);
    return { status: 'ok', files: files.sort() };
  } catch (err) {
    return { status: 'unreadable', reason: `${dir}: ${errorMessage(err)}` };
  }
}

function walk(root: string, rel: string, depthLeft: number, out: string[]): void {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isFile() || (entry.isSymbolicLink() && isFile(path.join(root, child)))) out.push(child);
    else if (entry.isDirectory() && depthLeft > 0) walk(root, child, depthLeft - 1, out);
  }
}

function readHead(file: string, bytes: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    // A file that is not there has no head; any other failure is the caller's to see.
    if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export const diskAgentFiles: AgentFiles = {
  exists: (p) => fs.existsSync(p),
  isFolder: (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true,
  folderNames: (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(),
  readHead,
  readText,
  listFiles,
  realPath: realpathOrResolve,
};
