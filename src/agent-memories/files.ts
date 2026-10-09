// Read-only file access shared by the adapters: size, binary and failure checks live in one place.
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/log.js';

export const MAX_ITEM_BYTES = 256 * 1024;
const MAX_DEPTH = 8;

export type TextFile =
  | { readonly ok: true; readonly text: string; readonly mtimeMs: number }
  | { readonly ok: false; readonly reason: string };

/** A file's text, or why it was skipped: empty, too big, holds a NUL byte (not text), or unreadable. */
export function readTextFile(file: string): TextFile {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, reason: `${file}: not a file` };
    // A tool rewriting a file truncates it first; read as holding no notes, every row would be set aside.
    if (stat.size === 0) return { ok: false, reason: `${file}: empty` };
    if (stat.size > MAX_ITEM_BYTES) return { ok: false, reason: `${file}: over ${MAX_ITEM_BYTES} bytes` };
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return { ok: false, reason: `${file}: not text` };
    return { ok: true, text: buf.toString('utf8'), mtimeMs: stat.mtimeMs };
  } catch (err) {
    return { ok: false, reason: `${file}: ${errorMessage(err)}` };
  }
}

export type DirListing =
  | { readonly status: 'ok'; readonly files: readonly string[] }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

/** Files in a folder as '/'-separated relative paths, sorted; dot entries skipped, symlinked folders not followed. */
export function listFiles(dir: string, opts: { recursive: boolean }): DirListing {
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

function isFile(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
}

export interface Frontmatter {
  /** The YAML between the fences, or null when the file has none. */
  readonly yaml: string | null;
  readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function splitFrontmatter(raw: string): Frontmatter {
  const m = raw.match(FRONTMATTER);
  return m ? { yaml: m[1], body: m[2] } : { yaml: null, body: raw };
}

/** One top-level scalar from frontmatter YAML, quotes removed; enough for `modified`, no YAML parser needed. */
export function frontmatterField(yaml: string, field: string): string | null {
  const m = yaml.match(new RegExp(`^${field}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  if (!m) return null;
  return m[1].replace(/^(['"])(.*)\1$/, '$2');
}

/** An item's time: the date string when it parses and is not in the future, else the fallback. */
export function itemTime(dateText: string | null, fallbackMs: number, nowMs: number = Date.now()): number {
  const parsed = dateText === null ? NaN : Date.parse(dateText);
  const t = Number.isFinite(parsed) ? parsed : fallbackMs;
  return Math.min(t, nowMs);
}

/** `~/x` against the given home; anything else unchanged. */
export function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p;
}
