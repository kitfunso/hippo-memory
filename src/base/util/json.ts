// Leaf module: the one value space JSON.parse can produce, so boundary guards narrow a shared type.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number';
}

export function isJsonBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === 'boolean';
}

/** A non-null, non-array object. */
export function isJsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Like `isJsonObject`, but also false for an object whose own `constructor` key shadows `Object`. */
export function isJsonObjectLiteral(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== undefined && value !== null && !Array.isArray(value) && value.constructor === Object;
}

/** `JSON.parse` typed as the values it can produce, so a reader narrows with the guards above instead of a cast. */
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

/** The parsed value, or undefined when the text is not JSON; only the parser's SyntaxError is absorbed. */
export function tryParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}
