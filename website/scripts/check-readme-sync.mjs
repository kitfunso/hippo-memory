#!/usr/bin/env node
/**
 * README <-> page drift guard.
 *
 * The landing page's comparison matrix (src/content/site.ts `comparison`) is a VERBATIM
 * copy of the README's #comparison table. This guard fails the build if a distinctive
 * comparison cell or a system name in site.ts is no longer present in README.md, so the
 * page cannot silently drift from the source of truth.
 *
 * Best-effort, not a parser: it text-extracts the cell/system string literals from
 * site.ts (no .ts import) and substring-checks them against the README's Comparison
 * section, after normalizing markdown backslash-escapes (e.g. `oracle\*` -> `oracle*`)
 * and collapsing whitespace. Trivial cells (Yes/No/?/N/A) are skipped - only distinctive
 * cells (with parens, %, or length > 6) are asserted. Receipt claim numbers are a WARN,
 * not a failure (README wording can legitimately change).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const normalize = (s) => s.replace(/\\/g, '').replace(/\s+/g, ' ').trim();

const readme = await readFile(join(root, '..', 'README.md'), 'utf8');
const site = await readFile(join(root, 'src', 'content', 'site.ts'), 'utf8');

// Scope to the README's Comparison section so common words don't match elsewhere.
const cmpStart = readme.indexOf('## Comparison');
const cmpEnd = cmpStart >= 0 ? readme.indexOf('\n## ', cmpStart + 3) : -1;
const cmpNorm = normalize(cmpStart >= 0 ? readme.slice(cmpStart, cmpEnd > 0 ? cmpEnd : undefined) : readme);
const readmeNorm = normalize(readme);

// Extract comparison cell strings from every `cells: [ ... ]` array in site.ts.
// Best-effort: [^\]]* assumes no cell literal contains a ']' (true today); a future cell
// with ']' would truncate that row's extraction. The README remains the canonical source.
const cells = [];
for (const arr of site.match(/cells:\s*\[([^\]]*)\]/g) || []) {
  for (const lit of arr.match(/'([^']*)'/g) || []) cells.push(lit.slice(1, -1));
}
// Extract system names from the `systems: [ ... ]` block.
const sysBlock = (site.match(/systems:\s*\[([\s\S]*?)\],/) || [])[1] || '';
const systems = (sysBlock.match(/name:\s*'([^']*)'/g) || []).map((m) => m.replace(/name:\s*'([^']*)'/, '$1'));

// Only assert distinctive cells (skip trivial Yes/No/?/N/A that match anywhere).
const distinctive = [...new Set(cells.filter((c) => c.length > 6 || c.includes('(') || c.includes('%')))];

const missing = [];
for (const c of distinctive) if (!cmpNorm.includes(normalize(c))) missing.push(`cell: "${c}"`);
for (const s of systems) if (!cmpNorm.includes(normalize(s))) missing.push(`system: "${s}"`);

const warns = ['R@5 = 74.0%', '926 tests', '0 outbound HTTP'].filter((c) => !readmeNorm.includes(normalize(c)));
if (warns.length) {
  console.warn('[readme-sync] WARN: receipt claim(s) not found verbatim in README (verify wording):', warns.join(' | '));
}

if (missing.length) {
  console.error('[readme-sync] DRIFT: site.ts comparison entries missing from README.md #comparison:');
  for (const m of missing) console.error('  - ' + m);
  console.error('Fix: the README is the source of truth - update README.md and site.ts together.');
  process.exit(1);
}

console.log(`[readme-sync] OK: ${distinctive.length} distinctive cells + ${systems.length} systems match README #comparison.`);
