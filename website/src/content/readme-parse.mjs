// Plain JS so both the Astro build (readme.ts) and the Node drift guard in CI parse the README the same way.
export const REPO = 'https://github.com/kitfunso/hippo-memory';

const MD_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|])/g;

/** @param {string} s */
export const unescapeMd = (s) => s.replace(MD_ESCAPE, '$1');

export const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Markdown to plain text for JSON-LD: code keeps its text, a link keeps its label, emphasis marks go.
 * @param {string} md */
export function mdText(md) {
  /** @type {string[]} */
  const code = [];
  const text = md
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(LINK, '$1')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(?<![\\\w*])([*_])(?=\S)([^*_\n]*?\S)\1(?![\w*])/g, '$2');
  return unescapeMd(text).replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
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

/** @param {string} text README.md with \n line endings */
export function parseComparison(text) {
  const body = section(text, '## Comparison');
  const [header, , ...rowLines] = body.split('\n').filter((l) => l.startsWith('|'));
  if (!header || !rowLines.length) throw new Error('README.md Comparison section has no table');
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
  // Footnotes open with an escaped asterisk and stay markdown, for mdInline.
  const footnotes = body.split('\n').filter((l) => l.startsWith('\\*'));
  if (!footnotes.length) throw new Error('README.md Comparison section has no footnotes');
  return { systems, rows, footnotes };
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
