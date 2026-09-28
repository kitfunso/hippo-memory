// Plain JS so both the Astro build (readme.ts) and the Node drift guard in CI parse the README the same way.
export const REPO = 'https://github.com/kitfunso/hippo-memory';

const MD_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|])/g;

/** @param {string} s */
export const unescapeMd = (s) => s.replace(MD_ESCAPE, '$1');

export const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Markdown to plain text for JSON-LD: code keeps its text, a link keeps its label, emphasis marks go.
 * @param {string} md */
export function mdText(md) {
  // Code spans wait behind U+E000 (private use, so never README text, and not a control character).
  /** @type {string[]} */
  const code = [];
  const text = md
    .replace(/`([^`]+)`/g, (_, c) => `\u{E000}${code.push(c) - 1}\u{E000}`)
    .replace(LINK, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(?<![\\\w*])([*_])(?=\S)([^*_\n]*?\S)\1(?![\w*])/g, '$2');
  return unescapeMd(text).replace(/\u{E000}(\d+)\u{E000}/gu, (_, i) => code[Number(i)]);
}

/** @param {string} text @param {string} heading */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`README.md has no "${heading}" section`);
  const end = text.indexOf('\n## ', start + heading.length + 2);
  return text.slice(start + heading.length + 2, end < 0 ? undefined : end);
}

/** @param {string} line */
const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** @param {string[]} lines one markdown table: header, separator, rows */
function parseTable(lines) {
  const [header, , ...rowLines] = lines;
  if (!rowLines.length || lines.some((l) => !l.startsWith('|'))) throw new Error('README.md Comparison has a malformed table');
  const systems = cellsOf(header).slice(1).map((cell, i) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(cell);
    return { name: link ? link[1] : cell, href: link ? link[2] : REPO, self: i === 0 };
  });
  const rows = rowLines.map((line) => {
    const [feature, ...cells] = cellsOf(line).map((c) => unescapeMd(c));
    if (cells.length !== systems.length) {
      throw new Error(`README.md Comparison row "${feature}" has ${cells.length} cells, expected ${systems.length}`);
    }
    return { feature, cells };
  });
  return { systems, rows };
}

/** @param {string} text README.md with \n line endings */
export function parseComparison(text) {
  const body = section(text, '## Comparison');
  // Two tables, plain facts and then design bets, so a bet never reads as a measured fact.
  const tables = body.split(/\n\s*\n/).map((p) => p.trim().split('\n')).filter((lines) => lines[0].startsWith('|'));
  if (tables.length !== 2) throw new Error(`README.md Comparison section has ${tables.length} tables, expected 2 (facts, design bets)`);
  const [facts, bets] = tables.map(parseTable);
  if (bets.systems.map((s) => s.name).join() !== facts.systems.map((s) => s.name).join()) {
    throw new Error('README.md Comparison tables name different systems');
  }
  // Footnotes open with an escaped asterisk and stay markdown, for mdInline.
  const footnotes = body.split('\n').filter((l) => l.startsWith('\\*'));
  if (!footnotes.length) throw new Error('README.md Comparison section has no footnotes');
  return { systems: facts.systems, rows: facts.rows, bets: bets.rows, footnotes };
}

/** @param {string} text README.md with \n line endings */
export function parseFaq(text) {
  const items = section(text, '## FAQ').split('\n---')[0].split('\n### ').slice(1).map((block) => {
    const [q, ...rest] = block.split('\n');
    return { q: q.trim(), a: rest.join('\n').trim() };
  });
  if (!items.length || items.some((f) => !f.a)) throw new Error('README.md FAQ has no questions, or a question has no answer');
  return items;
}
