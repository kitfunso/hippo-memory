// CommonMark's code span and "**" rules, read once for the quality gate and the capture extractor.

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WORD = /[\p{L}\p{N}_]/u;

/** Every maximal backtick run of `text` as [start, end), grouped by its length, in text order. */
function runsByLength(text: string): Map<number, Array<[number, number]>> {
  const byLength = new Map<number, Array<[number, number]>>();
  for (const { 0: run, index } of text.matchAll(/`+/g)) {
    const same = byLength.get(run.length) ?? [];
    same.push([index, index + run.length]);
    byLength.set(run.length, same);
  }
  return byLength;
}

/** `text` with each code span replaced by `fill`, same length; an opener with no closer is text. */
export function blankCodeSpans(text: string, fill = 'x'): string {
  const byLength = runsByLength(text);
  // Openers only move forward, so each length keeps a cursor that never goes back.
  const cursor = new Map<number, number>();
  const closerEnd = (length: number, from: number): number => {
    const same = byLength.get(length) ?? [];
    let k = cursor.get(length) ?? 0;
    while (k < same.length && same[k][0] < from) k++;
    cursor.set(length, k);
    return k < same.length ? same[k][1] : -1;
  };
  let out = '';
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    if (text[at] === '\\') {
      at += 2;
      continue;
    }
    if (text[at] !== '`') {
      at++;
      continue;
    }
    let end = at;
    while (text[end] === '`') end++;
    const close = closerEnd(end - at, end);
    if (close < 0) {
      at = end;
      continue;
    }
    out += text.slice(copied, at) + fill.repeat(close - at);
    copied = at = close;
  }
  return out + text.slice(copied);
}

/** One `**` delimiter run and the roles CommonMark gives it. */
export interface StrongMarker {
  readonly index: number;
  /** Left-flanking: it can open a span. */
  readonly open: boolean;
  /** Right-flanking: it can close a span. */
  readonly close: boolean;
  /** A word character on both sides, as in "2**10" and "foo**bar". */
  readonly inWord: boolean;
}

function charBefore(text: string, i: number): string {
  if (i === 0) return '';
  const unit = text.charCodeAt(i - 1);
  const pair = unit >= 0xdc00 && unit <= 0xdfff && i >= 2 && text.charCodeAt(i - 2) >= 0xd800;
  return pair ? text.slice(i - 2, i) : text[i - 1];
}

function charAfter(text: string, i: number): string {
  const point = text.codePointAt(i);
  return point === undefined ? '' : String.fromCodePoint(point);
}

const isSpace = (char: string): boolean => char === '' || /\s/u.test(char);
const isPunctuation = (char: string): boolean => char !== '' && PUNCTUATION.test(char);

interface Candidate {
  readonly marker: StrongMarker;
  /** A `/` follows: the `**` may start a path or a glob. */
  readonly slashed: boolean;
}

/** Each `**` of `text` (code spans blanked) in order; a run after `/`, `*` or a backslash, or before `*`, is a glob. */
export function strongMarkers(text: string): StrongMarker[] {
  const found: Candidate[] = [];
  for (const { index } of text.matchAll(/\*\*/g)) {
    const before = charBefore(text, index);
    const after = charAfter(text, index + 2);
    if (['/', '*', '\\'].includes(before) || after === '*') continue;
    const [spaceBefore, spaceAfter] = [isSpace(before), isSpace(after)];
    const [markBefore, markAfter] = [isPunctuation(before), isPunctuation(after)];
    const marker = {
      index,
      open: !spaceAfter && (!markAfter || spaceBefore || markBefore),
      close: !spaceBefore && (!markBefore || spaceAfter || markAfter),
      inWord: WORD.test(before) && WORD.test(after),
    };
    found.push({ marker, slashed: after === '/' });
  }
  // "**/etc/hosts**" is bold when the next marker closes it with no space between; else it is "**/".
  const bold = ({ marker, slashed }: Candidate, i: number): boolean => {
    const next = found[i + 1];
    if (!slashed) return true;
    if (next === undefined || next.slashed || !next.marker.close) return false;
    return !/\s/.test(text.slice(marker.index + 2, next.marker.index));
  };
  return found.filter(bold).map(({ marker }) => marker);
}
