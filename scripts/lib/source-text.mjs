// Shared by the check scripts: one comment stripper, so every gate reads the same text.
/** Blanks comments but keeps every newline, so offsets and line numbers still map to the original. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
