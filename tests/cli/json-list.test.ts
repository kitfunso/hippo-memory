// printJsonList prints, a page at a time, the bytes one JSON.stringify of the whole list would print.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printJsonList } from '../../src/surface/cli/json-list.js';

async function* pagesOf<T>(pages: readonly T[][]): AsyncGenerator<T[]> {
  for (const page of pages) yield page;
}

async function printed<T>(pages: readonly T[][]): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(line);
  });
  try {
    await printJsonList('cards', pagesOf(pages));
  } finally {
    spy.mockRestore();
  }
  return `${lines.join('\n')}\n`;
}

afterEach(() => vi.restoreAllMocks());

describe('printJsonList', () => {
  const items = [
    { id: 'a', title: 'line one\nline two', tags: ['x', 'y'], nested: { deep: [1, { z: null }] } },
    { id: 'b', title: 'separators   and   and \r stay inside the string', empty: [], none: {} },
    { id: 'c', title: '' },
  ];

  it.each([
    ['no pages', []],
    ['one empty page', [[]]],
    ['one page', [items]],
    ['pages of one with an empty one between', [[items[0]!], [], [items[1]!], [items[2]!]]],
  ])('matches JSON.stringify of the whole list: %s', async (_label, pages) => {
    const whole = { cards: pages.flat() };
    expect(await printed(pages)).toBe(`${JSON.stringify(whole, null, 2)}\n`);
  });
});
