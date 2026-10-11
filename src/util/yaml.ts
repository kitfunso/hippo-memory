/** Minimal YAML frontmatter serializer/deserializer with no external deps: simple key-value pairs and inline arrays, enough for the MemoryEntry schema. */

type YamlValue = string | number | boolean | null | string[] | number[];

const SCALAR_LOOKALIKE = /^(null|true|false|-?\d+(\.\d+)?)$/;
const UNESCAPES: ReadonlyMap<string, string> = new Map([['\\', '\\'], ['"', '"'], ['n', '\n'], ['r', '\r']]);

function escapeString(s: string): string {
  // A string that reads as null, a boolean or a number is quoted so it comes back a string.
  if (/[:#[\]{},\n\r"']/.test(s) || s.trim() !== s || s === '' || SCALAR_LOOKALIKE.test(s)) {
    const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return `"${escaped}"`;
  }
  return s;
}

// An unknown escape stays as written, so a hand-written Windows path still reads back.
function unescapeQuoted(body: string): string {
  return body.replace(/\\([\s\S])/g, (all, ch: string) => UNESCAPES.get(ch) ?? all);
}

function parseString(raw: string): string {
  const t = raw.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? unescapeQuoted(t.slice(1, -1)) : t;
}

function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuotes && ch === '\\') i++;
    else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  return items.map(parseString);
}

function isYamlBoolean(val: YamlValue): val is boolean {
  return typeof val === 'boolean';
}

function isYamlNumber(val: YamlValue): val is number {
  return typeof val === 'number';
}

function isYamlString(val: YamlValue): val is string {
  return typeof val === 'string';
}

function serializeValue(val: YamlValue): string {
  if (val === null) return 'null';
  if (isYamlBoolean(val)) return val ? 'true' : 'false';
  if (isYamlNumber(val)) return String(val);
  if (isYamlString(val)) return escapeString(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = val.map((v) => escapeString(String(v))).join(', ');
    return `[${items}]`;
  }
  return String(val);
}

export function dumpFrontmatter(obj: Record<string, YamlValue>): string {
  const lines = Object.entries(obj).map(([k, v]) => `${k}: ${serializeValue(v)}`);
  return `---\n${lines.join('\n')}\n---`;
}

function parseValue(raw: string): YamlValue {
  const s = raw.trim();
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  // Array: [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInlineList(inner);
  }

  // Quoted string
  if (s.startsWith('"') && s.endsWith('"')) return parseString(s);

  // Number
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return parseFloat(s);
  }

  return s;
}

export interface ParsedFrontmatter {
  data: Record<string, YamlValue>;
  content: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  const frontLines = match[1].split('\n');
  const data: Record<string, YamlValue> = {};

  for (let i = 0; i < frontLines.length; i++) {
    const line = frontLines[i];
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;

    if (val === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < frontLines.length) {
        const listLine = frontLines[j].trim();
        if (!listLine.startsWith('- ')) break;
        items.push(parseString(listLine.slice(2)));
        j++;
      }

      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
        continue;
      }
    }

    data[key] = parseValue(val);
  }

  return { data, content: match[2] };
}
