// Cuts stored text without splitting a surrogate pair.

/** Cut to `maxChars` UTF-16 units, backing off one unit rather than leave half a surrogate pair in a stored field. */
export function truncateCodePointSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}
