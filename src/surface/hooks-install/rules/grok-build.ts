import { isDeepStrictEqual } from 'node:util';
import { npxMentionsHippo, runsHippoMcp, type McpMaybeHippo } from './mcp-config.js';
import {
  isTomlTable,
  readToml,
  type TomlRead,
  type TomlStatement,
  type TomlValue,
} from './toml-read.js';

export type GrokStatus = 'absent' | 'present' | 'kept' | 'user-owned' | 'unreadable' | McpMaybeHippo;

interface GrokLine {
  readonly content: string;
  readonly eol: string;
}

interface GrokInspection {
  readonly status: GrokStatus;
  readonly drop: readonly number[];
}

interface Fact {
  readonly path: readonly string[];
  readonly statement: TomlStatement;
  readonly value?: TomlValue;
}

const BOM = '﻿';
const HEADER = '[mcp_servers.hippo]';
const ARGS_LINE = 'args = ["mcp"]';
const OWN_COMMANDS: readonly string[] = ['hippo', 'hippo.cmd'];
const MCP_SERVERS = 'mcp_servers';
const HIPPO = 'hippo';
const OWN_HEADER = /^\[mcp_servers\.hippo\][ \t]*$/;
const BLANK = /^[ \t]*$/;

const USER_OWNED: GrokInspection = { status: 'user-owned', drop: [] };
const KEPT: GrokInspection = { status: 'kept', drop: [] };
const ABSENT: GrokInspection = { status: 'absent', drop: [] };
const UNREADABLE: GrokInspection = { status: 'unreadable', drop: [] };

function splitLines(text: string): GrokLine[] {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const raws = body.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  return raws.map((raw) => {
    const content = raw.replace(/[\r\n]+$/, '');
    return { content, eol: raw.slice(content.length) };
  });
}

function isString(value: TomlValue | undefined): value is string {
  return typeof value === 'string';
}

function isStringList(value: TomlValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function valueFacts(path: readonly string[], value: TomlValue, statement: TomlStatement): Fact[] {
  const inner = isTomlTable(value)
    ? Object.entries(value).flatMap(([key, item]) => valueFacts([...path, key], item, statement))
    : [];
  return [{ path, value, statement }, ...inner];
}

const factsOf = (statement: TomlStatement): Fact[] =>
  statement.kind === 'key'
    ? valueFacts(statement.path, statement.value, statement)
    : [{ path: statement.path, statement }];

const isHippoFact = (fact: Fact): boolean => fact.path[0] === MCP_SERVERS && fact.path[1] === HIPPO;
const touchesHippo = (statement: TomlStatement): boolean => factsOf(statement).some(isHippoFact);
const sealsMcpServers = (statement: TomlStatement): boolean =>
  statement.kind !== 'table' && isDeepStrictEqual(statement.path, [MCP_SERVERS]);

function serverNames(facts: readonly Fact[]): string[] {
  const names = facts.filter((fact) => fact.path.length > 1 && fact.path[0] === MCP_SERVERS);
  return [...new Set(names.map((fact) => fact.path[1]))];
}

function valueAt(facts: readonly Fact[], path: readonly string[]): TomlValue | undefined {
  const found = facts.filter((fact) => isDeepStrictEqual(fact.path, path));
  return found.length === 1 ? found[0].value : undefined;
}

function serverCommandAndArgs(
  facts: readonly Fact[],
  name: string,
): { readonly command: string; readonly args: readonly string[] } | null {
  const server = [MCP_SERVERS, name];
  const isArrayTable = (fact: Fact): boolean =>
    fact.statement.kind === 'array-table' && isDeepStrictEqual(fact.path, server);
  if (facts.some(isArrayTable)) return null;
  const command = valueAt(facts, [...server, 'command']);
  const args = valueAt(facts, [...server, 'args']);
  return isString(command) && isStringList(args) ? { command, args } : null;
}

function serverRunsHippoMcp(facts: readonly Fact[], name: string): boolean {
  const pair = serverCommandAndArgs(facts, name);
  return pair !== null && runsHippoMcp(pair.command, pair.args);
}

function serverMayRunHippo(facts: readonly Fact[], name: string): boolean {
  const pair = serverCommandAndArgs(facts, name);
  return pair !== null && npxMentionsHippo(pair.command, pair.args);
}

const trimmedLine = (lines: readonly GrokLine[], statement: TomlStatement): string =>
  lines[statement.line].content.replace(/^[ \t]+|[ \t]+$/g, '');

function isOwnTable(hippo: readonly Fact[], lines: readonly GrokLine[]): boolean {
  if (hippo.length !== 3) return false;
  const [table, command, args] = hippo.map((fact) => fact.statement);
  return (
    table.kind === 'table' &&
    OWN_HEADER.test(lines[table.line].content) &&
    command.kind === 'key' &&
    OWN_COMMANDS.some((own) => trimmedLine(lines, command) === `command = "${own}"`) &&
    args.kind === 'key' &&
    trimmedLine(lines, args) === ARGS_LINE
  );
}

function sameStatement(a: TomlStatement, b: TomlStatement): boolean {
  if (a.kind !== b.kind || !isDeepStrictEqual(a.path, b.path)) return false;
  return a.kind !== 'key' || (b.kind === 'key' && isDeepStrictEqual(a.value, b.value));
}

const sameStatements = (a: readonly TomlStatement[], b: readonly TomlStatement[]): boolean =>
  a.length === b.length && a.every((statement, index) => sameStatement(statement, b[index]));

function withoutLines(text: string, lines: readonly GrokLine[], drop: readonly number[]): string {
  const bom = text.startsWith(BOM) ? BOM : '';
  const kept = lines.filter((_, index) => !drop.includes(index));
  return bom + kept.map((line) => line.content + line.eol).join('');
}

function ownInspection(
  text: string,
  read: TomlRead,
  lines: readonly GrokLine[],
  hippo: readonly Fact[],
): GrokInspection {
  const header = hippo[0].statement.line;
  const blankBefore = header > 0 && BLANK.test(lines[header - 1].content) ? [header - 1] : [];
  const drop = [...hippo.map((fact) => fact.statement.line), ...blankBefore];
  const after = readToml(withoutLines(text, lines, drop));
  const others = read.statements.filter((statement) => !touchesHippo(statement));
  return after !== null && sameStatements(after.statements, others)
    ? { status: 'present', drop }
    : UNREADABLE;
}

function appendTable(text: string, command: string): string {
  const lines = splitLines(text);
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';
  const table = grokTableLines(command)
    .map((line) => line + eol)
    .join('');
  if (lines.length === 0) return text + table;
  const endsOpen = lines[lines.length - 1].eol === '';
  return text + (endsOpen ? eol : '') + eol + table;
}

function appendedIfHolds(text: string, read: TomlRead, command: string): string | null {
  if (read.statements.some(sealsMcpServers)) return null;
  const next = appendTable(text, command);
  const after = readToml(next);
  const table = readToml(grokTableLines(command).join('\n'));
  if (after === null || table === null) return null;
  return sameStatements(after.statements, [...read.statements, ...table.statements]) ? next : null;
}

function inspectRead(text: string, read: TomlRead): GrokInspection {
  const facts = read.statements.flatMap(factsOf);
  const hippo = facts.filter(isHippoFact);
  if (hippo.length === 0) {
    if (serverNames(facts).some((name) => serverRunsHippoMcp(facts, name))) return KEPT;
    const maybeHippo = serverNames(facts).find((name) => serverMayRunHippo(facts, name));
    if (maybeHippo !== undefined) return { status: { maybeHippo }, drop: [] };
    return appendedIfHolds(text, read, OWN_COMMANDS[0]) === null ? UNREADABLE : ABSENT;
  }
  const lines = splitLines(text);
  if (isOwnTable(hippo, lines)) return ownInspection(text, read, lines, hippo);
  if (serverRunsHippoMcp(facts, HIPPO)) return KEPT;
  if (serverMayRunHippo(facts, HIPPO)) return { status: { maybeHippo: HIPPO }, drop: [] };
  return USER_OWNED;
}

function inspect(text: string): GrokInspection {
  const read = readToml(text);
  return read === null ? UNREADABLE : inspectRead(text, read);
}

export function grokStatus(text: string): GrokStatus {
  return inspect(text).status;
}

export function grokTableLines(command: string): string[] {
  return [HEADER, `command = "${command}"`, ARGS_LINE];
}

export function planGrokInstall(text: string, command: string): string {
  const read = readToml(text);
  if (read === null || inspectRead(text, read).status !== 'absent') return text;
  return appendedIfHolds(text, read, command) ?? text;
}

export function planGrokRemoval(text: string): string | null {
  const { status, drop } = inspect(text);
  return status === 'present' ? withoutLines(text, splitLines(text), drop) : null;
}
