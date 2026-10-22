// Which rows a store read may answer as holding a text, once for both adapters: equal once every space is gone, or a
// sleep-merged row holding it. Every copy heldTextKeys finds passes, so a caller that checks again keeps its answer.

/** The code points JavaScript's \s matches, which duplicateKey folds; the SQL twin removes the same list. */
export const SPACE_CODES: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

const SPACES = new RegExp(`[${SPACE_CODES.map((code) => `\\u{${code.toString(16)}}`).join('')}]`, 'gu');

/** `text` with every space removed: two texts duplicateKey calls equal are equal here too. */
export const bareText = (text: string): string => text.replace(SPACES, '');

/** True when `row` may hold one of the texts whose bare forms are `bares`: its own bare text is one, or it is a
 * sleep-merged row whose bare text contains one. */
export function mayHoldCopy(
  row: { readonly content: string; readonly source?: string | null },
  bares: ReadonlySet<string>,
): boolean {
  const bare = bareText(row.content);
  if (bares.has(bare)) return true;
  if (row.source !== 'consolidation') return false;
  for (const held of bares) if (bare.includes(held)) return true;
  return false;
}
