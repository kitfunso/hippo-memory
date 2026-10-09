// Hand-written for the JSON Schema subset the hippo tool definitions use, so the MCP server needs no validator dependency.

const ARG_PREVIEW_CHARS = 40;

export type ToolArgValue = string | number | boolean | null | ToolArgValue[] | { [key: string]: ToolArgValue };

/** One property of a tool's inputSchema. Keywords outside this subset are not supported. */
export interface ToolPropertySchema {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
}

/** A tool's inputSchema: an object with named properties and an optional required list. */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ToolPropertySchema>>;
  readonly required?: readonly string[];
}

function isArgString(v: ToolArgValue): v is string {
  return typeof v === 'string';
}

function isArgBoolean(v: ToolArgValue): v is boolean {
  return typeof v === 'boolean';
}

function isArgNumber(v: ToolArgValue): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

// LLM clients often send numbers as strings, and the handlers Number-coerce, so "4000" counts as 4000 while "12abc" does not.
function asNumber(v: ToolArgValue): number | null {
  if (isArgNumber(v)) return v;
  if (isArgString(v) && NUMERIC_STRING.test(v.trim())) return Number(v.trim());
  return null;
}

function describeValue(v: ToolArgValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (isArgString(v)) return JSON.stringify(v.length > ARG_PREVIEW_CHARS ? `${v.slice(0, ARG_PREVIEW_CHARS)}...` : v);
  if (isArgNumber(v) || isArgBoolean(v)) return String(v);
  return 'object';
}

function checkProperty(name: string, schema: ToolPropertySchema, raw: ToolArgValue): string | null {
  const got = ` (got ${describeValue(raw)})`;
  const isNumeric = schema.type === 'number' || schema.type === 'integer';
  const value = isNumeric ? asNumber(raw) : raw;
  switch (schema.type) {
    case 'string':
      if (!isArgString(value)) return `${name} must be a string${got}`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${name} must be at most ${schema.maxLength} characters (got ${value.length})`;
      }
      break;
    case 'boolean':
      if (!isArgBoolean(value)) return `${name} must be a boolean${got}`;
      break;
    case 'number':
    case 'integer':
      if (value === null || !isArgNumber(value)) return `${name} must be a number${got}`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${name} must be an integer${got}`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${name} must be >= ${schema.minimum}${got}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${name} must be <= ${schema.maximum}${got}`;
      break;
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    return `${name} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}${got}`;
  }
  return null;
}

/** One message per violation; undeclared properties pass, and `checkedDownstream` names keep the API layer's own error contract. */
export function validateToolArgs(
  schema: ToolInputSchema,
  args: Readonly<Record<string, ToolArgValue>>,
  checkedDownstream: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(args, name)) problems.push(`${name} is required`);
  }
  for (const [name, propSchema] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(args, name) || checkedDownstream.has(name)) continue;
    const problem = checkProperty(name, propSchema, args[name]);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}
