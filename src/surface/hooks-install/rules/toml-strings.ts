type Quote = '"' | "'";
type Open = '' | '"""' | "'''";

function runLength(line: string, from: number, quote: Quote): number {
  let end = from;
  while (line[end] === quote) end++;
  return end - from;
}

function endOfMultiline(line: string, from: number, quote: Quote): number {
  let i = from;
  while (i < line.length) {
    if (quote === '"' && line[i] === '\\') {
      i += 2;
    } else if (line[i] === quote) {
      const run = runLength(line, i, quote);
      if (run >= 3) return i + run;
      i += run;
    } else {
      i++;
    }
  }
  return -1;
}

function endOfSingleLine(line: string, from: number, quote: Quote): number {
  let i = from;
  while (i < line.length) {
    if (quote === '"' && line[i] === '\\') i += 2;
    else if (line[i] === quote) return i + 1;
    else i++;
  }
  return line.length;
}

function stateAfter(line: string, open: Open): Open {
  let state = open;
  let i = 0;
  while (i < line.length) {
    if (state !== '') {
      const end = endOfMultiline(line, i, state === '"""' ? '"' : "'");
      if (end === -1) return state;
      state = '';
      i = end;
    } else if (line[i] === '#') {
      return '';
    } else if (line[i] === '"' || line[i] === "'") {
      const quote: Quote = line[i] === '"' ? '"' : "'";
      if (line.startsWith(quote.repeat(3), i)) {
        state = quote === '"' ? '"""' : "'''";
        i += 3;
      } else {
        i = endOfSingleLine(line, i + 1, quote);
      }
    } else {
      i++;
    }
  }
  return state;
}

export function startsOutsideString(lines: readonly string[]): boolean[] {
  let open: Open = '';
  return lines.map((line) => {
    const outside = open === '';
    open = stateAfter(line, open);
    return outside;
  });
}
