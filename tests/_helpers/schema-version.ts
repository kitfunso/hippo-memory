import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Parsed from src/db.ts text so `getCurrentSchemaVersion()` assertions still check the code, not itself.
const dbSource = readFileSync(fileURLToPath(new URL('../../src/db.ts', import.meta.url)), 'utf8');
const match = /^const CURRENT_SCHEMA_VERSION = (\d+);/m.exec(dbSource);
if (!match) throw new Error('CURRENT_SCHEMA_VERSION not found in src/db.ts');

export const LATEST_SCHEMA_VERSION: number = Number(match[1]);
export const LATEST_SCHEMA_VERSION_STR: string = match[1];
