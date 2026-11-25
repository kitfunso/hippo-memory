export type GrokStatus = 'absent' | 'present' | 'user-owned';

interface GrokLine {
  readonly content: string;
  readonly eol: string;
}

interface GrokScan {
  readonly tables: readonly number[];
  readonly otherForm: boolean;
}

interface GrokInspection {
  readonly status: GrokStatus;
  readonly drop: readonly number[];
}

type Section = 'root' | 'mcp_servers' | 'other';

const BOM = '﻿';
const HEADER = '[mcp_servers.hippo]';
const ARGS_LINE = 'args = ["mcp"]';
const OWN_COMMANDS: readonly string[] = ['hippo', 'hippo.cmd'];

const WS = '[ \\t]*';
const key = (name: string): string => `${WS}(?:${name}|"${name}"|'${name}')${WS}`;
const MCP_SERVERS = key('mcp_servers');
const HIPPO = key('hippo');

const ANY_HEADER = new RegExp(`^${WS}\\[`);
const BLANK = new RegExp(`^${WS}$`);
const BLANK_OR_COMMENT = new RegExp(`^${WS}(?:#.*)?$`);
const HIPPO_HEADER = new RegExp(`^${WS}\\[\\[?${MCP_SERVERS}\\.${HIPPO}(?:\\]|\\.)`);
const OWN_HEADER = new RegExp(`^${WS}\\[${MCP_SERVERS}\\.${HIPPO}\\]${WS}$`);
const MCP_SERVERS_HEADER = new RegExp(`^${WS}\\[${MCP_SERVERS}\\]${WS}(?:#.*)?$`);
const ROOT_HIPPO_KEY = new RegExp(`^${MCP_SERVERS}\\.${HIPPO}[=.]`);
const ROOT_INLINE_TABLE = new RegExp(`^${MCP_SERVERS}=`);
const SERVER_HIPPO_KEY = new RegExp(`^${HIPPO}[=.]`);

const USER_OWNED: GrokInspection = { status: 'user-owned', drop: [] };

function splitLines(text: string): GrokLine[] {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const raws = body.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  return raws.map((raw) => {
    const content = raw.replace(/[\r\n]+$/, '');
    return { content, eol: raw.slice(content.length) };
  });
}

function sectionAfterHeader(line: string): Section {
  return MCP_SERVERS_HEADER.test(line) ? 'mcp_servers' : 'other';
}

function isOtherHippoForm(line: string, section: Section): boolean {
  if (section === 'root') return ROOT_HIPPO_KEY.test(line) || ROOT_INLINE_TABLE.test(line);
  return section === 'mcp_servers' && SERVER_HIPPO_KEY.test(line);
}

function scan(contents: readonly string[]): GrokScan {
  const tables: number[] = [];
  let section: Section = 'root';
  let otherForm = false;
  contents.forEach((line, index) => {
    if (!ANY_HEADER.test(line)) {
      otherForm = otherForm || isOtherHippoForm(line, section);
      return;
    }
    if (HIPPO_HEADER.test(line)) tables.push(index);
    section = sectionAfterHeader(line);
  });
  return { tables, otherForm };
}

function bodyLineIndexes(contents: readonly string[], header: number): number[] {
  const found: number[] = [];
  for (let i = header + 1; i < contents.length && !ANY_HEADER.test(contents[i]); i++) {
    if (!BLANK_OR_COMMENT.test(contents[i])) found.push(i);
  }
  return found;
}

function isOwnBody(contents: readonly string[], body: readonly number[]): boolean {
  if (body.length !== 2) return false;
  const [command, args] = body.map((i) => contents[i].replace(/^[ \t]+|[ \t]+$/g, ''));
  return OWN_COMMANDS.some((own) => command === `command = "${own}"`) && args === ARGS_LINE;
}

function inspect(lines: readonly GrokLine[]): GrokInspection {
  const contents = lines.map((line) => line.content);
  const { tables, otherForm } = scan(contents);
  if (tables.length === 0) return otherForm ? USER_OWNED : { status: 'absent', drop: [] };
  const header = tables[0];
  if (tables.length > 1 || otherForm || !OWN_HEADER.test(contents[header])) return USER_OWNED;
  const body = bodyLineIndexes(contents, header);
  if (!isOwnBody(contents, body)) return USER_OWNED;
  const blankBefore = header > 0 && BLANK.test(contents[header - 1]) ? [header - 1] : [];
  return { status: 'present', drop: [header, ...body, ...blankBefore] };
}

export function grokStatus(text: string): GrokStatus {
  return inspect(splitLines(text)).status;
}

export function grokTableLines(command: string): string[] {
  return [HEADER, `command = "${command}"`, ARGS_LINE];
}

export function planGrokInstall(text: string, command: string): string {
  if (grokStatus(text) !== 'absent') return text;
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';
  const table = grokTableLines(command)
    .map((line) => line + eol)
    .join('');
  if (lines.length === 0) return text + table;
  const endsOpen = lines[lines.length - 1].eol === '';
  return text + (endsOpen ? eol : '') + eol + table;
}

export function planGrokRemoval(text: string): string | null {
  const lines = splitLines(text);
  const { status, drop } = inspect(lines);
  if (status !== 'present') return null;
  const kept = lines.filter((_, index) => !drop.includes(index));
  const bom = text.startsWith(BOM) ? BOM : '';
  return bom + kept.map((line) => line.content + line.eol).join('');
}
