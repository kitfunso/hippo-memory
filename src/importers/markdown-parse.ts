import * as fs from 'fs';
import * as path from 'path';
import { realpathOrResolve } from '../util/real-path.js';

/** Minimal inline frontmatter split (no YAML dep) on a leading `---\n...\n---\n` block; returns the key-value map plus the body,
 *  or an empty `fm` and the original content when no well-formed block is present. */
interface FrontmatterParseResult {
  fm: Record<string, string>;
  body: string;
}

export function splitMarkdownFrontmatter(raw: string): FrontmatterParseResult {
  // Must start with `---` on its own line. Accept CRLF or LF.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);
  const fm: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '') {
      // YAML block-style list (`key:` then indented `- item` lines, common in Obsidian/Dendron): collect into a comma-joined value for frontmatterList.
      const items: string[] = [];
      let j = i + 1;
      let item: RegExpMatchArray | null;
      while (j < lines.length && (item = lines[j].match(/^\s+-\s+(.+?)\s*$/)) !== null) {
        items.push(item[1].replace(/^['"]|['"]$/g, '').trim());
        j++;
      }
      if (items.length) {
        val = items.join(', ');
        i = j - 1;
      }
    }
    fm[kv[1]] = val;
  }
  return { fm, body };
}

/** Pull a frontmatter field that may be a YAML flow list (`[a, b]`), a comma-separated scalar, or one token into a string[];
 *  quotes and brackets are stripped and empty entries dropped. */
export function frontmatterList(value: string | undefined): string[] {
  if (!value) return [];
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** Parse `[[wikilinks]]` from body text: `[[target]]` and `[[target|alias]]` both yield `target`; de-duplicated, order-preserving.
 *  Embeds (`![[...]]`) match too, because the leading `!` is outside the capture and a candidate target is harmless. */
export function parseWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+?)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const inner = match[1];
    const target = (inner.split('|')[0] ?? '').trim();
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/** Recursively collect files matching `match` (`*.md` default) under `root` as forward-slash relative paths; symlinks are not followed.
 *  Skips dot-directories and the Hippo store path so a vault containing the store never imports its own mirror files; importVault handles root-IS-the-store. */
export function collectMarkdownFiles(root: string, hippoRoot: string, match: RegExp = /\.md$/i): string[] {
  const out: string[] = [];
  // Canonicalize (realpath) so a non-dot HIPPO_HOME store nested in the vault is skipped even via a junction or Windows case alias.
  const resolvedHippoRoot = realpathOrResolve(hippoRoot);
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip dot-dirs (config/system, incl. the default `.hippo` store) and
        // the canonicalized store path (covers a HIPPO_HOME outside `.hippo`).
        if (ent.name.startsWith('.')) continue;
        if (realpathOrResolve(abs) === resolvedHippoRoot) continue;
        walk(abs);
      } else if (ent.isFile() && match.test(ent.name)) {
        out.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  out.sort();
  return out;
}
