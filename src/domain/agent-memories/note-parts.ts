import path from 'node:path';
import { truncateCodePointSafe } from '../../base/util/code-point-cut.js';
import {
  maskEmails,
  redactSecretsStrict,
  secretSpans,
  type SecretSpan,
} from '../../base/util/secret-detect.js';
import { headingOfKey, sha256Hex, textItemKeys } from './keys.js';
import { closesFence, fenceOf, markdownHeading, slugHeading } from './markdown.js';
import { CONTENT_CAP, PART_MARK } from './source.js';
import type { Container, MemoryItem } from './types.js';

const HEAD_CAP = 200;

interface Piece {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface Section {
  readonly heading: string;
  readonly slug: string;
  readonly headingLines: readonly Piece[];
  readonly lines: Piece[];
}

interface Part extends Piece {
  readonly slug: string;
}

interface Cut {
  readonly note: string;
  readonly budget: number;
  readonly spans: readonly SecretSpan[];
}

const size = (text: string): number => maskEmails(text).length;

const overCap = (item: MemoryItem): boolean => size(item.text) > CONTENT_CAP;

/** Each item over the cap replaced by its parts, in note order; other items stay as they are. */
export function splitContainer(container: Container): Container {
  if (!container.items.some(overCap)) return container;
  const fileTitle = (item: MemoryItem): string =>
    container.textKeyed ? path.basename(container.path) : path.posix.basename(item.key);
  const noteOf = (item: MemoryItem): string =>
    container.textKeyed ? headingOfKey(item.key) : item.key;
  const seen = new Map<string, number>();
  return {
    ...container,
    items: container.items.flatMap((item) =>
      overCap(item) ? noteParts(item, item.title ?? fileTitle(item), noteOf(item), seen) : [item],
    ),
  };
}

function noteParts(
  item: MemoryItem,
  title: string,
  noteKey: string,
  seen: Map<string, number>,
): MemoryItem[] {
  const note = item.text;
  const spans = flaggedSpans(note);
  const parts = sectionsOf(noteLines(note, 0, note.length)).flatMap((section) =>
    sectionParts({ note, budget: CONTENT_CAP, spans }, section, title),
  );
  const keys = textItemKeys(
    parts.map((p) => ({ headingSlug: `${noteKey}${PART_MARK}${p.slug}`, text: p.text })),
    seen,
  );
  return parts.map((part, i) => ({
    key: keys[i],
    text: part.text,
    updatedAt: item.updatedAt,
    title,
    flagged: spans.some((s) => s.start < part.end && s.end > part.start),
  }));
}

function flaggedSpans(note: string): SecretSpan[] {
  if (redactSecretsStrict(note) === note) return [];
  const spans = secretSpans(note);
  let rest = note;
  for (const s of spans) {
    rest = rest.slice(0, s.start) + ' '.repeat(s.end - s.start) + rest.slice(s.end);
  }
  return redactSecretsStrict(rest) === rest ? spans : [{ start: 0, end: note.length }];
}

function sectionParts(whole: Cut, section: Section, title: string): Part[] {
  const { heading } = section;
  const line = heading === '' || heading === title ? title : `${title} > ${heading}`;
  const fits = size(line) <= HEAD_CAP;
  const head = `${fits ? line : truncateCodePointSafe(title, HEAD_CAP)}\n\n`;
  const lines = fits ? section.lines : [...section.headingLines, ...section.lines];
  const cut: Cut = { ...whole, budget: whole.budget - size(head) };
  return packPieces(cut, blocksOf(cut.note, lines), (piece) => splitBlock(cut, piece)).map(
    (piece) => ({ ...piece, slug: section.slug, text: head + piece.text }),
  );
}

function noteLines(note: string, from: number, to: number): Piece[] {
  const lines: Piece[] = [];
  for (let start = from; start <= to;) {
    const nl = note.indexOf('\n', start);
    const stop = nl < 0 || nl > to ? to : nl;
    const end = stop > start && note[stop - 1] === '\r' ? stop - 1 : stop;
    lines.push({ start, end, text: note.slice(start, end) });
    start = stop + 1;
  }
  return lines;
}

function fenceAfter(open: string | null, line: string): string | null {
  if (open === null) return fenceOf(line);
  return closesFence(line, open) ? null : open;
}

function sectionsOf(lines: readonly Piece[]): Section[] {
  const sections: Section[] = [{ heading: '', slug: slugHeading(''), headingLines: [], lines: [] }];
  let fence: string | null = null;
  for (const line of lines) {
    const heading = fence === null ? markdownHeading(line.text) : null;
    const last = sections[sections.length - 1];
    if (heading === null) last.lines.push(line);
    else if (last.heading !== '' && !last.lines.some((l) => l.text.trim() !== '')) {
      sections[sections.length - 1] = {
        heading: `${last.heading} > ${heading}`,
        slug: partSlug(heading),
        headingLines: [...last.headingLines, line],
        lines: [],
      };
    } else sections.push({ heading, slug: partSlug(heading), headingLines: [line], lines: [] });
    fence = fenceAfter(fence, line.text);
  }
  return sections.filter((s) => s.lines.some((l) => l.text.trim() !== ''));
}

function partSlug(heading: string): string {
  const slug = slugHeading(heading);
  return slug === 'top' ? `h-${sha256Hex(heading).slice(0, 8)}` : slug;
}

function blocksOf(note: string, lines: readonly Piece[]): Piece[] {
  const blocks: Piece[][] = [];
  let current: Piece[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (fence === null && line.text.trim() === '') flush();
    else {
      if (fence === null && fenceOf(line.text) !== null) flush();
      current.push(line);
      fence = fenceAfter(fence, line.text);
      if (fence === null && fenceOf(current[0].text) !== null) flush();
    }
  }
  flush();
  return blocks.map((b) => slice(note, b[0].start, b[b.length - 1].end));
}

function slice(note: string, start: number, end: number): Piece {
  return { start, end, text: note.slice(start, end) };
}

function keepSpansWhole(cut: Cut, pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    const spanned = last && cut.spans.some((s) => s.start < piece.start && s.end > last.end);
    if (spanned) out[out.length - 1] = slice(cut.note, last.start, piece.end);
    else out.push(slice(cut.note, piece.start, piece.end));
  }
  return out;
}

function packPieces(cut: Cut, pieces: readonly Piece[], finer: (piece: Piece) => Piece[]): Piece[] {
  const out: Piece[] = [];
  let open: Piece | null = null;
  for (const piece of keepSpansWhole(cut, pieces)) {
    if (size(piece.text) > cut.budget) {
      if (open !== null) out.push(open);
      open = null;
      out.push(...finer(piece));
      continue;
    }
    const joined: Piece = open === null ? piece : slice(cut.note, open.start, piece.end);
    if (size(joined.text) <= cut.budget) open = joined;
    else {
      if (open !== null) out.push(open);
      open = piece;
    }
  }
  if (open !== null) out.push(open);
  return out;
}

function splitBlock(cut: Cut, block: Piece): Piece[] {
  const lines = noteLines(cut.note, block.start, block.end);
  const fence = fenceOf(lines[0].text);
  if (fence !== null && lines.length > 1) return fenceParts(cut, lines, fence);
  return packLines(cut, lines);
}

function packLines(cut: Cut, lines: readonly Piece[]): Piece[] {
  const words = (line: Piece): Piece[] =>
    packPieces(cut, wordsOf(cut.note, line), (word) => hardCut(cut, word));
  return packPieces(cut, lines, words);
}

function fenceParts(cut: Cut, lines: readonly Piece[], fence: string): Piece[] {
  const open = lines[0].text;
  const last = lines[lines.length - 1].text;
  const closed = lines.length > 1 && closesFence(last, fence);
  const close = closed ? last : fence;
  const inner = lines.slice(1, closed ? -1 : undefined);
  if (inner.length === 0) return packLines(cut, lines);
  const room: Cut = { ...cut, budget: cut.budget - size(open) - size(close) - 2 };
  if (room.budget < cut.budget / 2) return packLines(cut, lines);
  return packLines(room, inner).map((p) => ({ ...p, text: `${open}\n${p.text}\n${close}` }));
}

function wordsOf(note: string, line: Piece): Piece[] {
  const words: Piece[] = [];
  for (const m of line.text.matchAll(/\S+/g)) {
    const start = line.start + m.index;
    words.push(slice(note, start, start + m[0].length));
  }
  return words;
}

function hardCut(cut: Cut, piece: Piece): Piece[] {
  const out: Piece[] = [];
  for (let at = piece.start; at < piece.end;) {
    const inside = cut.spans.find((s) => s.start <= at && s.end > at);
    let to = inside ? Math.min(piece.end, inside.end) : cutPoint(cut, at, piece.end);
    const next = cut.spans.find((s) => s.start > at && s.start < to && s.end > to);
    if (!inside && next) to = next.start;
    out.push(slice(cut.note, at, to));
    at = to;
  }
  return out;
}

function cutPoint(cut: Cut, from: number, to: number): number {
  let end = from + truncateCodePointSafe(cut.note.slice(from, to), cut.budget).length;
  while (end > from + 1 && size(cut.note.slice(from, end)) > cut.budget) end--;
  return Math.max(end, from + 1);
}
