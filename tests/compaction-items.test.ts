import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPACTION_ITEM_MAX_CHARS,
  COMPACTION_ITEM_ROW_CAP,
  compactSummaryBody,
  parseCompactionItems,
  selectItemRows,
} from '../src/util/compaction-items.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'compaction',
  'post-compact-payloads.jsonl',
);

const parse = (...lines: string[]) => parseCompactionItems(lines.join('\n'));

describe('parseCompactionItems: heading', () => {
  it.each([
    ['plain colon', 'Memories for hippo:'],
    ['bold', '**Memories for hippo**'],
    ['bold with colon inside', '**Memories for hippo:**'],
    ['## heading', '## Memories for hippo'],
    ['numbered', '10. Memories for hippo:'],
    ['numbered bold', '10. **Memories for hippo**'],
    ['any case', 'MEMORIES FOR HIPPO'],
  ])('finds the %s shape', (_name, heading) => {
    expect(parse('summary text', '', heading, '- one', '- two')).toEqual({ found: true, items: ['one', 'two'] });
  });

  it('does not match the phrase inside prose', () => {
    const out = parse('The user asked for a Memories for hippo section.', '- not an item');
    expect(out).toEqual({ found: false, items: [] });
  });

  it('never returns the heading line as an item', () => {
    const { items } = parse('## Memories for hippo', '- a lesson');
    expect(items).toEqual(['a lesson']);
    expect(items.join(' ')).not.toMatch(/memories for hippo/i);
  });

  it('uses the last heading when the phrase heads a section twice', () => {
    const out = parse('Memories for hippo:', '- old', '', 'Other section', 'Memories for hippo:', '- new');
    expect(out.items).toEqual(['new']);
  });

  it('reports found=false for a summary without the section', () => {
    expect(parse('1. Primary Request', '- a bullet that is not ours')).toEqual({ found: false, items: [] });
  });

  it('reports found=true and no items for a heading with nothing after it', () => {
    expect(parse('Memories for hippo:')).toEqual({ found: true, items: [] });
  });
});

describe('parseCompactionItems: items', () => {
  it('reads dash, star and numbered markers without the marker', () => {
    const out = parse('Memories for hippo:', '- dash', '* star', '1. dot', '2) paren', '  - indented dash');
    expect(out.items).toEqual(['dash', 'star', 'dot', 'paren', 'indented dash']);
  });

  it('makes a nested bullet its own item', () => {
    const out = parse('Memories for hippo:', '- parent', '  - child', '    * grandchild', '- sibling');
    expect(out.items).toEqual(['parent', 'child', 'grandchild', 'sibling']);
  });

  it('joins an indented unmarked line onto the previous item with one space', () => {
    const out = parse('Memories for hippo:', '- first part of a long', '    second part   ', '  third', '- next');
    expect(out.items).toEqual(['first part of a long second part third', 'next']);
  });

  it('allows blank lines between items and before a wrapped line', () => {
    const out = parse('Memories for hippo:', '', '- one', '', '', '- two', '', '  wrapped', '', '- three');
    expect(out.items).toEqual(['one', 'two wrapped', 'three']);
  });

  it('ends the list at </summary>', () => {
    const out = parse('Memories for hippo:', '- one', '- two', '</summary>', '- after the tag');
    expect(out.items).toEqual(['one', 'two']);
  });

  it('keeps an item that shares its line with </summary>', () => {
    expect(parse('Memories for hippo:', '- one', '- two</summary>').items).toEqual(['one', 'two']);
  });

  it('ends the list at the first unindented non-item line', () => {
    const out = parse('Memories for hippo:', '- one', 'A closing remark.', '- two');
    expect(out.items).toEqual(['one']);
  });

  it('does not treat a decimal or bold text at line start as an item', () => {
    const out = parse('Memories for hippo:', '- one', '1.5 million rows', '- two');
    expect(out.items).toEqual(['one']);
    expect(parse('Memories for hippo:', '**Bold** remark', '- two').items).toEqual([]);
  });

  it('reads Windows line endings', () => {
    const out = parseCompactionItems('Memories for hippo:\r\n- one\r\n  more\r\n- two\r\n');
    expect(out.items).toEqual(['one more', 'two']);
  });

  it('skips an empty bullet and does not glue a later wrapped line to the item before it', () => {
    const out = parse('Memories for hippo:', '- one', '-', '  orphan', '- two');
    expect(out.items).toEqual(['one', 'two']);
  });

  it.each(['- none', '- None', '- NONE.', '* none.', '1. none'])('drops "%s"', (line) => {
    expect(parse('Memories for hippo:', line)).toEqual({ found: true, items: [] });
  });

  it('keeps an item that only starts with none', () => {
    expect(parse('Memories for hippo:', '- none of the tests ran').items).toEqual(['none of the tests ran']);
  });

  it('never cuts an item, however long', () => {
    const long = 'x'.repeat(600);
    expect(parse('Memories for hippo:', `- ${long}`).items).toEqual([long]);
  });
});

describe('selectItemRows', () => {
  it('turns 11 items into 10 rows and counts 1 capped, while the parser keeps all 11', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `- item ${i + 1}`);
    const { items } = parse('Memories for hippo:', ...lines);
    expect(items).toHaveLength(11);
    const out = selectItemRows(items);
    expect(out.rows).toEqual(items.slice(0, COMPACTION_ITEM_ROW_CAP));
    expect(out).toMatchObject({ tooLong: 0, capped: 1 });
  });

  it('keeps a 600-char item out of the rows and counts it too long', () => {
    const long = 'y'.repeat(600);
    const { items } = parse('Memories for hippo:', '- short', `- ${long}`);
    expect(items).toContain(long);
    expect(selectItemRows(items)).toEqual({ rows: ['short'], tooLong: 1, capped: 0 });
  });

  it('accepts exactly the max length and refuses one char more', () => {
    const at = 'a'.repeat(COMPACTION_ITEM_MAX_CHARS);
    const over = 'b'.repeat(COMPACTION_ITEM_MAX_CHARS + 1);
    expect(selectItemRows([at, over])).toEqual({ rows: [at], tooLong: 1, capped: 0 });
  });

  it('counts too-long items apart from capped and does not spend row slots on them', () => {
    const over = 'c'.repeat(COMPACTION_ITEM_MAX_CHARS + 1);
    const items = [over, ...Array.from({ length: 11 }, (_, i) => `item ${i + 1}`)];
    const out = selectItemRows(items);
    expect(out.rows).toEqual(items.slice(1, 1 + COMPACTION_ITEM_ROW_CAP));
    expect(out).toMatchObject({ tooLong: 1, capped: 1 });
  });

  it('returns nothing for no items', () => {
    expect(selectItemRows([])).toEqual({ rows: [], tooLong: 0, capped: 0 });
  });
});

describe('compactSummaryBody', () => {
  it('returns the summary body with the analysis block removed', () => {
    const text = '<analysis>\nthinking\n</analysis>\n\n<summary>\n1. Intent\n\nMemories for hippo:\n- a\n</summary>';
    expect(compactSummaryBody(text)).toBe('1. Intent\n\nMemories for hippo:\n- a');
  });

  it('removes an analysis block that mentions the summary tag', () => {
    const text = '<analysis>I will write a <summary> next.</analysis>\n<summary>\nreal body\n</summary>';
    expect(compactSummaryBody(text)).toBe('real body');
  });

  it('takes the last summary block when there are several', () => {
    expect(compactSummaryBody('<summary>old</summary>\n<summary>new</summary>')).toBe('new');
  });

  it('returns the whole trimmed text minus analysis when there is no summary tag', () => {
    expect(compactSummaryBody('  <analysis>x</analysis>\nplain body\n')).toBe('plain body');
  });

  it('reads to the end when the closing tag is missing', () => {
    expect(compactSummaryBody('<summary>\ncut off here\n- a')).toBe('cut off here\n- a');
  });

  it('feeds the parser end to end', () => {
    const text = '<summary>\nWork.\n\nMemories for hippo:\n- one\n- two\n</summary>';
    expect(parseCompactionItems(compactSummaryBody(text)).items).toEqual(['one', 'two']);
  });

  it('removes every closed analysis block, from its first opening tag, and keeps an unclosed one', () => {
    expect(compactSummaryBody('a<analysis>1</analysis>b<analysis><analysis>2</analysis>c<analysis>open')).toBe('abc<analysis>open');
  });
});

describe('hostile input is read in linear time', () => {
  const REPEATS = 100_000;
  const LIMIT_MS = 2_000;

  it('leaves 200,000 unclosed analysis tags as they are', () => {
    const text = '<analysis>'.repeat(2 * REPEATS);
    expect(compactSummaryBody(text)).toBe(text);
  }, LIMIT_MS);

  it('finds no heading in a line of 300,000 tabs between two letters', () => {
    expect(parseCompactionItems(`x${'\t'.repeat(3 * REPEATS)}x`)).toEqual({ found: false, items: [] });
  }, LIMIT_MS);

  it('ends the list at a marker line whose text holds a bare carriage return after 200,000 spaces', () => {
    const line = `* ${'  '.repeat(REPEATS)}a\rb`;
    expect(parseCompactionItems(`Memories for hippo:\n- one\n${line}\n- two`)).toEqual({ found: true, items: ['one'] });
  }, LIMIT_MS);
});

describe('parseCompactionItems: odd whitespace', () => {
  it('reads an item whose gap after the marker holds a carriage return or a line separator', () => {
    expect(parse('Memories for hippo:', '- \r\rone', '* two', '-   ', '- three  ').items).toEqual(['one', 'two', 'three']);
  });

  it('finds a heading behind a long run of trailing stars, colons and spaces', () => {
    expect(parse(`## **Memories for hippo${'*: \t'.repeat(50)}`, '- one')).toEqual({ found: true, items: ['one'] });
  });
});

describe('post-compact payload fixtures', () => {
  const payloads = fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => ({ compact_summary: String(JSON.parse(l).compact_summary) }));

  it('holds the five recorded payloads', () => {
    expect(payloads).toHaveLength(5);
  });

  it('finds the section in every payload and never leaks the heading into an item', () => {
    for (const p of payloads) {
      const { found, items } = parseCompactionItems(compactSummaryBody(p.compact_summary));
      expect(found).toBe(true);
      for (const item of items) expect(item).not.toContain('Memories for hippo');
    }
  });

  it('reads the item counts each payload lists', () => {
    const counts = payloads.map((p) => parseCompactionItems(compactSummaryBody(p.compact_summary)).items.length);
    expect(counts).toEqual([4, 1, 2, 2, 0]);
  });

  it('gives zero items for the "- none" payload', () => {
    const last = payloads[payloads.length - 1];
    expect(parseCompactionItems(compactSummaryBody(last.compact_summary))).toEqual({ found: true, items: [] });
  });

  it('reads the plain-colon and the bold heading shapes as whole standalone sentences', () => {
    const first = parseCompactionItems(compactSummaryBody(payloads[0].compact_summary)).items;
    expect(first[0]).toBe('This repo uses pnpm for all package operations and never npm, because npm rewrote the lockfile and broke CI twice.');
    const third = parseCompactionItems(compactSummaryBody(payloads[2].compact_summary)).items;
    expect(third[1]).toBe('Database migrations for this repo must never run on a Friday, because the user was burned by a Friday outage.');
  });

  it('sends every fixture item through selectItemRows as rows', () => {
    for (const p of payloads) {
      const { items } = parseCompactionItems(compactSummaryBody(p.compact_summary));
      expect(selectItemRows(items)).toEqual({ rows: items, tooLong: 0, capped: 0 });
    }
  });
});
