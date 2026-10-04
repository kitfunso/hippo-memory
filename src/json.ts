// Leaf module: the one value space JSON.parse can produce, so boundary guards narrow a shared type.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}
