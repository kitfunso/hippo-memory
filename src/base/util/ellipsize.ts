/** `text` cut to `max` characters plus a marker, or unchanged when it already fits. */
export function truncateWithEllipsis(text: string, max: number, marker = '...'): string {
  return text.length > max ? `${text.slice(0, max)}${marker}` : text;
}
