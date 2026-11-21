// The texts a memory with a lead-in shows, finds and compares by. A row with no lead-in gives its
// content alone from each.

export interface LeadInText {
  readonly content: string;
  readonly leadIn?: string | null;
}

/** The text a search matches: content first, so an embedder that truncates cuts the lead-in. */
export function findableText(e: LeadInText): string {
  return e.leadIn ? `${e.content}\n${e.leadIn}` : e.content;
}

/** The text recall shows and prices: the lead-in above the content it led into. */
export function shownText(e: LeadInText): string {
  return e.leadIn ? `${e.leadIn}\n${e.content}` : e.content;
}

/** The leadIn key for an item or JSON row, absent when unset so old output stays byte-equal. */
export function leadInField(e: LeadInText): { leadIn?: string } {
  return e.leadIn ? { leadIn: e.leadIn } : {};
}

/** The SQL twin of findableText, for the FTS repair; a parity test pins the two. */
export const FINDABLE_TEXT_SQL = (m: string): string =>
  `CASE WHEN COALESCE(${m}.lead_in, '') = '' THEN ${m}.content ` +
  `ELSE ${m}.content || char(10) || ${m}.lead_in END`;
