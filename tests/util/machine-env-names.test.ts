// A Machine's env holds only the variables envMachine names, so a path rule reading one it leaves out would read unset.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envMachine } from '../../src/base/util/env.js';

const SRC = resolve(import.meta.dirname, '../../src');
// env.ts reads process.env, whose `.env.NAME` reads would match too.
const ENV_MODULE = join(SRC, 'base', 'util', 'env.ts');
const READ = /\benv\??\.([A-Z][A-Z0-9_]*)\b/g;
const DESTRUCTURED = /const \{([^}]*)\} = [\w.]*\benv;/g;
const BY_CONSTANT = /\benv\[([A-Z][A-Z0-9_]*)\]/g;

/** Every variable a src file reads off an env map, by name or by a constant its file declares. */
function variablesRead(): Set<string> {
  const read = new Set<string>();
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || file === ENV_MODULE) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(READ)) read.add(m[1]);
    for (const m of text.matchAll(BY_CONSTANT)) {
      read.add(new RegExp(`const ${m[1]} = '([A-Z][A-Z0-9_]*)'`).exec(text)?.[1] ?? m[1]);
    }
    for (const m of text.matchAll(DESTRUCTURED)) {
      for (const name of m[1].matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)) read.add(name[1]);
    }
  }
  return read;
}

describe('envMachine', () => {
  it('names every variable the path rules read off a Machine env', () => {
    const read = [...variablesRead()];
    expect(read).toEqual(expect.arrayContaining(['CODEX_HOME', 'OPENCLAW_HOME', 'HIPPO_AGENT_MEMORY_TOOLS']));
    const named = Object.keys(envMachine());
    expect(read.filter((name) => !named.includes(name)).sort()).toEqual([]);
  });
});
