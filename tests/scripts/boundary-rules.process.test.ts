import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..', '..');
const OXLINT = join(REPO, 'node_modules', 'oxlint', 'bin', 'oxlint');

interface Diagnostic {
  readonly code: string;
  readonly filename: string;
}

/** An oxlint rule setting: a severity, or a severity and its options. */
type RuleSetting = string | readonly [string, ...object[]];

interface RuleTable {
  readonly [rule: string]: RuleSetting;
}

interface Config {
  jsPlugins: { readonly name: string; specifier: string }[];
  rules?: RuleTable;
  overrides?: { rules?: RuleTable }[];
}

/** `rules` without the anti-slop ones. */
const withoutAntiSlop = (rules: RuleTable | undefined): RuleTable | undefined =>
  rules && Object.fromEntries(Object.entries(rules).filter(([name]) => !name.startsWith('anti-slop/')));

/** The repo's .oxlintrc.json in `root`, its plugin paths pointing back at the repo. The anti-slop
 * plugin is TypeScript, which Node 22.16 (the engines floor) cannot load, so it and its rules go. */
function configIn(root: string): string {
  // SAFETY: .oxlintrc.json is the repo's own config, whose jsPlugins entries all carry a specifier.
  const config = JSON.parse(readFileSync(join(REPO, '.oxlintrc.json'), 'utf8')) as Config;
  config.jsPlugins = config.jsPlugins
    .filter((plugin) => plugin.name !== 'anti-slop')
    .map((plugin) => ({ ...plugin, specifier: relative(root, join(REPO, plugin.specifier)).split(sep).join('/') }));
  config.rules = withoutAntiSlop(config.rules);
  for (const override of config.overrides ?? []) override.rules = withoutAntiSlop(override.rules);
  const file = join(root, '.oxlintrc.json');
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** Lints `files` under a fresh folder with the repo's rules; `file -> rule codes` for each hit. */
function lint(files: Record<string, string>): Map<string, string[]> {
  // macOS tmpdir sits behind the /var symlink; oxlint sees the real path, so the test must too.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-boundary-rules-')));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const args = [OXLINT, '-c', configIn(root), '-f', 'json', ...Object.keys(files)];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf-8' });
    // SAFETY: oxlint's json format prints { diagnostics: [...] } with a code and filename on each.
    const { diagnostics } = JSON.parse(r.stdout) as { diagnostics: Diagnostic[] };
    const hits = new Map<string, string[]>();
    for (const d of diagnostics) {
      const file = d.filename.split(sep).join('/');
      hits.set(file, [...(hits.get(file) ?? []), d.code]);
    }
    return hits;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('.oxlintrc.json boundary rules', () => {
  it('holds every signature kind to 5 positional parameters with one hit, past a rest or this one', () => {
    const hits = lint({
      'src/base/six.ts': 'export interface P {\n  m(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6): void;\n}\n',
      'src/base/new.ts': 'export type C = new (a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) => object;\n',
      'src/base/type.ts': 'export type F = (a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) => void;\n',
      'src/base/five.ts': 'export interface P {\n  m(this: void, a: 1, b: 2, c: 3, d: 4, e: 5, ...f: 6[]): void;\n}\n',
    });
    expect(hits.get('src/base/six.ts')).toEqual(['boundaries(max-signature-params)']);
    expect(hits.get('src/base/new.ts')).toEqual(['boundaries(max-signature-params)']);
    expect(hits.get('src/base/type.ts')).toEqual(['eslint(max-params)']);
    expect(hits.get('src/base/five.ts')).toBeUndefined();
  });

  it('fails SQLite in an api or domain name or string, and passes a module path, a comment and src/base', () => {
    const hits = lint({
      'src/api/name.ts': 'export const sqliteRows = 1;\n',
      'src/domain/text.ts': "export const why = 'opens SQLite';\n",
      'src/api/path.ts': "import { x } from '../store/sqlite/index.js';\nexport const y = x;\n",
      'src/domain/comment.ts': '// reads sqlite rows through the port\nexport const z = 1;\n',
      'src/base/name.ts': 'export const sqliteRows = 1;\n',
    });
    expect(hits.get('src/api/name.ts')).toEqual(['boundaries(no-adapter-name)']);
    expect(hits.get('src/domain/text.ts')).toEqual(['boundaries(no-adapter-name)']);
    expect(hits.get('src/api/path.ts')).toBeUndefined();
    expect(hits.get('src/domain/comment.ts')).toBeUndefined();
    expect(hits.get('src/base/name.ts')).toBeUndefined();
  });

  it('fails a route that imports or calls requireGroup, and the api naming hippoRoot', () => {
    const hits = lint({
      'src/surface/server/routes/imports.ts':
        "import { requireGroup } from '../../../base/ports/store.js';\nexport const p = requireGroup;\n",
      'src/surface/server/routes/calls.ts':
        "import * as ports from '../../../base/ports/store.js';\nexport const p = ports.requireGroup;\n",
      'src/api/root.ts': 'export const f = (o: { readonly hippoRoot: string }): string => o.hippoRoot;\n',
    });
    expect(hits.get('src/surface/server/routes/imports.ts')).toContain('eslint(no-restricted-imports)');
    expect(hits.get('src/surface/server/routes/calls.ts')).toContain('eslint(no-restricted-properties)');
    expect(hits.get('src/api/root.ts')).toContain('eslint(no-restricted-properties)');
  });
});
