import { runsHippoMcp } from './mcp-config.js';

export type GrokStatus = 'absent' | 'present' | 'kept' | 'user-owned';

interface GrokLine {
  readonly content: string;
  readonly eol: string;
}

interface GrokScan {
  readonly tables: readonly number[];
  readonly servers: readonly number[];
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
const SERVER_NAME = `(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`;
const SERVER_HEADER = new RegExp(
  `^${WS}\\[${MCP_SERVERS}\\.${WS}${SERVER_NAME}${WS}\\]${WS}(?:#.*)?$`,
);
const COMMAND_ENTRY = new RegExp(`^${WS}command${WS}=${WS}"([^"]*)"${WS}(?:#.*)?$`);
const ARGS_ENTRY = new RegExp(`^${WS}args${WS}=${WS}\\[(.*)\\]${WS}(?:#.*)?$`);

const USER_OWNED: GrokInspection = { status: 'user-owned', drop: [] };
const KEPT: GrokInspection = { status: 'kept', drop: [] };
const ABSENT: GrokInspection = { status: 'absent', drop: [] };

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
  const servers: number[] = [];
  let section: Section = 'root';
  let otherForm = false;
  contents.forEach((line, index) => {
    if (!ANY_HEADER.test(line)) {
      otherForm = otherForm || isOtherHippoForm(line, section);
      return;
    }
    if (HIPPO_HEADER.test(line)) tables.push(index);
    if (SERVER_HEADER.test(line)) servers.push(index);
    section = sectionAfterHeader(line);
  });
  return { tables, servers, otherForm };
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

function parseArgs(inner: string): string[] | null {
  if (inner.trim() === '') return [];
  const items = inner.trim().replace(/,$/, '').split(',');
  const values = items.map((item) => /^"([^"]*)"$/.exec(item.trim())?.[1]);
  return values.every((value) => value !== undefined) ? values : null;
}

const captures = (lines: readonly string[], pattern: RegExp): string[] =>
  lines.flatMap((line) => pattern.exec(line)?.[1] ?? []);

function runsHippoTable(contents: readonly string[], header: number): boolean {
  const body = bodyLineIndexes(contents, header).map((i) => contents[i]);
  const commands = captures(body, COMMAND_ENTRY);
  const argLists = captures(body, ARGS_ENTRY);
  if (commands.length !== 1 || argLists.length !== 1) return false;
  const args = parseArgs(argLists[0]);
  return args !== null && runsHippoMcp(commands[0], args);
}

function inspect(lines: readonly GrokLine[]): GrokInspection {
  const contents = lines.map((line) => line.content);
  const { tables, servers, otherForm } = scan(contents);
  if (tables.length === 0 && !otherForm) {
    return servers.some((server) => runsHippoTable(contents, server)) ? KEPT : ABSENT;
  }
  if (tables.length !== 1 || otherForm) return USER_OWNED;
  const header = tables[0];
  const body = bodyLineIndexes(contents, header);
  if (OWN_HEADER.test(contents[header]) && isOwnBody(contents, body)) {
    const blankBefore = header > 0 && BLANK.test(contents[header - 1]) ? [header - 1] : [];
    return { status: 'present', drop: [header, ...body, ...blankBefore] };
  }
  return servers.includes(header) && runsHippoTable(contents, header) ? KEPT : USER_OWNED;
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
