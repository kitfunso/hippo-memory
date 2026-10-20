// The shared flag the server gives a store other than hippo.db by itself, written where a hippo.db pass on the folder reads it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isJsonObject, type JsonValue } from '../../src/base/util/json.js';

export function shareRoot(root: string): void {
  const file = join(root, 'config.json');
  const held: JsonValue = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!isJsonObject(held)) throw new Error(`${file} must hold a JSON object`);
  writeFileSync(file, JSON.stringify({ ...held, sharedStore: true }));
}
