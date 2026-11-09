// One anchor rule for the FAQ questions and the page sections, so a heading and a link to it always agree.
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
