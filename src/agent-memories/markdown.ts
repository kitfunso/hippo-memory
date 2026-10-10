/** Splits one markdown memory file into items (a top-level bullet or a paragraph), each tagged with its heading. Pure. */

export interface MarkdownItem {
  readonly heading: string;      // nearest heading text above the item, '' when none
  readonly headingSlug: string;  // slug of heading, 'top' when heading is ''
  readonly text: string;         // the item text
}

interface Block {
  readonly end: number;
  readonly text: string;
}

const HEADING = /^#{1,6}\s+/;
// Column 0 only: an indented marker is a sub-bullet and stays inside its item.
const BULLET = /^(?:[-*+]|\d+[.)]) /;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
// A backtick fence's info string holds no backtick, so inline code at line start is not a fence.
const FENCE = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
const MAX_SLUG_LENGTH = 40;

/** Lowercase, punctuation runs folded to '-', cut to 40 characters; 'top' when nothing is left. */
export function slugHeading(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? 'top' : slug;
}

/** Split markdown into memory items in file order; headings set context and are never items. */
export function splitMarkdownItems(markdown: string): MarkdownItem[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const items: MarkdownItem[] = [];
  let heading = '';
  let headingSlug = slugHeading(heading);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || RULE.test(line)) {
      i++;
    } else if (HEADING.test(line)) {
      heading = headingText(line);
      headingSlug = slugHeading(heading);
      i++;
    } else {
      const block = readBlock(lines, i);
      if (block.text !== '') items.push({ heading, headingSlug, text: block.text });
      i = block.end;
    }
  }
  return items;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isIndented(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t');
}

function headingText(line: string): string {
  // A closing run of '#' counts only after a space, so `## C#` keeps its name.
  return line.replace(HEADING, '').trim().replace(/(?:^|\s+)#+$/, '').trim();
}

// Rules are tested first so `- - -` is a rule, not a bullet.
function startsBlock(line: string): boolean {
  return RULE.test(line) || HEADING.test(line) || BULLET.test(line);
}

function fenceOf(line: string): string | null {
  const match = FENCE.exec(line);
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed.replaceAll(fence[0], '') === '';
}

// An unclosed fence runs to the end of the file.
function skipFence(lines: readonly string[], start: number, fence: string): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (closesFence(lines[i], fence)) return i + 1;
  }
  return lines.length;
}

// A line opening a fence carries its whole body with it, so body lines never start a heading or bullet.
function afterLine(lines: readonly string[], i: number): number {
  const fence = fenceOf(lines[i]);
  return fence === null ? i + 1 : skipFence(lines, i, fence);
}

// Where a bullet resumes after blank lines: the next line when it is indented, else -1.
function resumeAfterBlank(lines: readonly string[], i: number): number {
  let next = i;
  while (next < lines.length && isBlank(lines[next])) next++;
  return next < lines.length && isIndented(lines[next]) ? next : -1;
}

// A bullet spans blank lines between indented lines; a paragraph ends at the first blank line.
function blockEnd(lines: readonly string[], start: number, isBullet: boolean): number {
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      const resume = isBullet ? resumeAfterBlank(lines, i) : -1;
      if (resume < 0) return i;
      i = resume;
    } else if (!isIndented(line) && startsBlock(line)) {
      return i;
    } else {
      i = afterLine(lines, i);
    }
  }
  return lines.length;
}

function readBlock(lines: readonly string[], start: number): Block {
  const fence = fenceOf(lines[start]);
  if (fence !== null) {
    const end = skipFence(lines, start, fence);
    return { end, text: lines.slice(start, end).join('\n').trim() };
  }
  const isBullet = BULLET.test(lines[start]);
  const end = blockEnd(lines, start, isBullet);
  const body = lines.slice(start, end);
  if (!isBullet) return { end, text: body.join('\n').trim() };
  body[0] = body[0].replace(BULLET, '');
  return { end, text: body.map((l) => l.trimEnd()).join('\n').trim() };
}
