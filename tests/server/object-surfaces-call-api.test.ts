// The /v1 route handlers and the CLI object verbs reach typed objects through src/api alone, so both surfaces make the
// same calls; a type-only import of src/domain is fine.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const CLI_OBJECT_VERBS = [
  'briefs',
  'decisions',
  'incidents',
  'notes',
  'object-verbs',
  'playbooks',
  'predictions',
  'versioned-verbs',
];
const RUNTIME_DOMAIN_IMPORT = /^(?:import|export) (?!type )[^;]*from '(?:\.\.\/)+domain\/[^']*';/gm;

const files = [
  ...readdirSync(`${SRC}surface/server/routes`).map((name) => `surface/server/routes/${name}`),
  ...CLI_OBJECT_VERBS.map((name) => `surface/cli/${name}.ts`),
];

describe('typed-object surfaces', () => {
  it('reads every file it guards', () => {
    expect(files.length).toBeGreaterThan(CLI_OBJECT_VERBS.length);
  });

  it.each(files)('%s imports nothing of src/domain at runtime', (file) => {
    expect(readFileSync(`${SRC}${file}`, 'utf8').match(RUNTIME_DOMAIN_IMPORT) ?? []).toEqual([]);
  });

  it('catches a runtime import and passes a type-only one', () => {
    const runtime = "import {\n  saveSkill,\n} from '../../../domain/objects/skills.js';\n";
    const typeOnly = "import type { Skill } from '../../domain/objects/skills.js';\n";
    expect(runtime.match(RUNTIME_DOMAIN_IMPORT)).toHaveLength(1);
    expect(typeOnly.match(RUNTIME_DOMAIN_IMPORT)).toBeNull();
  });
});
