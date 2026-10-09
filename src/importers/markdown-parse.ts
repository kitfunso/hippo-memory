import * as fs from 'fs';
import * as path from 'path';
import { realpathOrResolve } from '../util/real-path.js';

/** Minimal inline frontmatter split. Recognises a leading `---\n…\n---\n`
 *  block (no YAML dep). Returns the parsed key→value map plus the body with the
 *  block removed. When no well-formed block is present, `fm` is empty and
 *  `body` is the original content. */
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
      // YAML block-style list: `key:` followed by indented `- item` lines
      // (common in Obsidian/Dendron frontmatter). Collect them into a
      // comma-joined value so frontmatterList parses them (codex P2).
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

/** Pull a frontmatter field that may be a YAML flow list (`[a, b]`), a
 *  comma-separated scalar (`a, b`), or a single token, into a string[]. Quotes
 *  and surrounding brackets are stripped; empty entries dropped. */
export function frontmatterList(value: string | undefined): string[] {
  if (!value) return [];
  let v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** Parse `[[wikilinks]]` from body text. `[[target]]` and `[[target|alias]]`
 *  both yield `target` (alias dropped). Returns de-duplicated, order-preserving
 *  target strings (trimmed). Embeds (`![[…]]`) are intentionally matched too —
 *  the leading `!` is not part of the `[[…]]` capture, so an embed contributes
 *  its target as a candidate, which is the desired no-crash baseline behaviour. */
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

/** Recursively collect files whose name matches `match` (`*.md` by default) under `root`,
 *  as paths relative to `root` with forward-slash separators (stable artifactRef keys across OSes).
 *  Symlinks are not followed. Skips dot-directories (the default `.hippo` store,
 *  `.git`, `.obsidian`, `.trash`) AND the canonicalized Hippo store path during
 *  the walk, so re-importing a vault that CONTAINS the store never ingests its own
 *  markdown mirror files (codex R5 P1: `hippo import --vault .` after `hippo
 *  init` in the vault would otherwise self-import its mirror rows and grow on
 *  every run). The root-IS-the-store case is handled one level up in
 *  importVault (a no-op early return), NOT here: returning [] for it would feed
 *  the deletion-sync an empty scan that mass-archives every live row (codex R8). */
export function collectMarkdownFiles(root: string, hippoRoot: string, match: RegExp = /\.md$/i): string[] {
  const out: string[] = [];
  // Canonicalize (realpath) so a non-dot HIPPO_HOME store nested in the vault is
  // skipped even when hippoRoot is an aliased path (junction / Windows case
  // variant); path.resolve would miss it and self-import the store's mirror
  // files (codex R9 follow-up: same gap as the importVault guard, sibling site).
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
