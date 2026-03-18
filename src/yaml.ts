/**
 * Minimal YAML frontmatter serializer/deserializer.
 * No external deps. Handles simple key-value + arrays (inline only).
 * Sufficient for the MemoryEntry frontmatter schema.
 */

type YamlValue = string | number | boolean | null | string[] | number[];

function escapeString(s: string): string {
  // If string contains special chars, quote it
  if (/[:#\[\]{},\n\r"']/.test(s) || s.trim() !== s || s === '') {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function serializeValue(val: YamlValue): string {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') return escapeString(val);
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
    return inner.split(',').map((item) => {
      const t = item.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    });
  }

  // Quoted string
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

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
        items.push(listLine.slice(2).trim());
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
