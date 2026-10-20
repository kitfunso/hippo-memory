// Text rules shared by the adapters: frontmatter, item times and home-relative paths. The reads are Machine.files.
import path from 'node:path';

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
