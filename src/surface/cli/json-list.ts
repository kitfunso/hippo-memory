// A `--json` list printed a page at a time, so a verb that prints every row never holds them all.

/** Prints what `console.log(JSON.stringify({ [key]: items }, null, 2))` prints for every item `pages` yields, with one
 * page in hand at a time. */
export async function printJsonList<T>(key: string, pages: AsyncIterable<readonly T[]>): Promise<void> {
  const name = JSON.stringify(key);
  let pending: string | null = null;
  for await (const page of pages) {
    for (const item of page) {
      console.log(pending === null ? `{\n  ${name}: [` : `${pending},`);
      // JSON escapes every newline inside a string, so each one left starts a line of the item's own layout.
      pending = `    ${JSON.stringify(item, null, 2).replaceAll('\n', '\n    ')}`;
    }
  }
  console.log(pending === null ? `{\n  ${name}: []\n}` : `${pending}\n  ]\n}`);
}
