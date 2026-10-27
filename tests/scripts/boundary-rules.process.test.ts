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

const PROPERTY = 'eslint(no-restricted-properties)';
const IMPORT = 'eslint(no-restricted-imports)';

describe('.oxlintrc.json env, exit and outside-world rules', () => {
  it('fails process.env outside env.ts in each spelling, and process.exit outside the three process ends', () => {
    const hits = lint({
      'src/domain/member.ts': 'export const h = process.env.HOME;\n',
      'src/surface/cli/destructure.ts': 'const { env } = process;\nexport const h = env.HOME;\n',
      'src/api/global.ts': 'export const h = globalThis.process.env.HOME;\n',
      'src/base/util/env.ts': 'export const h = process.env.HOME;\n',
      'src/surface/cli/stop.ts': 'export const stop = (): never => process.exit(2);\n',
      'src/surface/server/sleep-child.ts': 'export const stop = (): never => process.exit(0);\n',
    });
    expect(hits.get('src/domain/member.ts')).toEqual([PROPERTY]);
    expect(hits.get('src/surface/cli/destructure.ts')).toEqual([PROPERTY]);
    expect(hits.get('src/api/global.ts')).toEqual([PROPERTY]);
    expect(hits.get('src/base/util/env.ts')).toBeUndefined();
    expect(hits.get('src/surface/cli/stop.ts')).toEqual(['unicorn(no-process-exit)']);
    expect(hits.get('src/surface/server/sleep-child.ts')).toBeUndefined();
  });

  it('fails a domain fetch or adapter import, and a loadConfig import in host outside config-file.ts', () => {
    const hits = lint({
      'src/domain/fetch.ts': 'export const get = async (u: string): Promise<Response> => fetch(u);\n',
      'src/domain/global-fetch.ts': 'export const get = async (u: string): Promise<Response> => globalThis.fetch(u);\n',
      'src/domain/by-name.ts':
        "import { fetchWithRetry } from '../base/util/net.js';\nexport const f = fetchWithRetry;\n",
      'src/domain/by-module.ts': "import { retries } from '../base/http-retry.js';\nexport const n = retries;\n",
      'src/host/read.ts': "import { loadConfig } from './config-file.js';\nexport const r = loadConfig;\n",
      'src/surface/cli/read.ts':
        "import { loadConfig } from '../../host/config-file.js';\nexport const r = loadConfig;\n",
    });
    expect(hits.get('src/domain/fetch.ts')).toEqual(['eslint(no-restricted-globals)']);
    expect(hits.get('src/domain/global-fetch.ts')).toEqual([PROPERTY]);
    expect(hits.get('src/domain/by-name.ts')).toEqual([IMPORT]);
    expect(hits.get('src/domain/by-module.ts')).toEqual([IMPORT]);
    expect(hits.get('src/host/read.ts')).toEqual([IMPORT]);
    expect(hits.get('src/surface/cli/read.ts')).toBeUndefined();
  });
});

describe('.oxlintrc.json CLI rules', () => {
  it('fails a flag turned into text by hand, and passes a list cast and a string', () => {
    const flag = (body: string): string => `export const f = (flags: Flags): string => ${body};\n`;
    const hits = lint({
      'src/surface/cli/a.ts': flag("String(flags.x ?? '')"),
      'src/surface/cli/b.ts': flag('`${flags.y}`'),
      'src/surface/cli/c.ts': flag('flags.z as string'),
      'src/surface/cli/d.ts': flag('String(flags.q.trim())'),
      'src/surface/cli/e.ts': 'export const f = (flags: Flags): string[] => flags.w as string[];\n',
      'src/surface/cli/g.ts': flag("flags.name ?? 'String(flags.q)'"),
    });
    for (const file of ['a', 'b', 'c', 'd']) {
      expect(hits.get(`src/surface/cli/${file}.ts`)).toEqual(['boundaries(no-hand-flag-read)']);
    }
    expect(hits.get('src/surface/cli/e.ts')).toBeUndefined();
    expect(hits.get('src/surface/cli/g.ts')).toBeUndefined();
  });

  it('fails printError followed by throw CliExit(1), across a multi-line call, and nothing else', () => {
    const pair = (lines: string[]): string => `export function f(c: boolean): void {\n${lines.join('\n')}\n}\n`;
    const hits = lint({
      'src/surface/cli/pair.ts': pair(['  printError(', '    `bad ${c}`,', '  );', '  throw new CliExit(1);']),
      'src/surface/cli/guarded.ts': pair(["  if (c) printError('y');", '  throw new CliExit(1);']),
      'src/surface/cli/code-2.ts': pair(['  printError(String(c));', '  throw new CliExit(2);']),
      'src/surface/cli/exit.ts': pair(['  printError(String(c));', '  throw new CliExit(1);']),
    });
    expect(hits.get('src/surface/cli/pair.ts')).toEqual(['boundaries(no-hand-fail)']);
    expect(hits.get('src/surface/cli/guarded.ts')).toBeUndefined();
    expect(hits.get('src/surface/cli/code-2.ts')).toBeUndefined();
    expect(hits.get('src/surface/cli/exit.ts')).toBeUndefined();
  });

  it('fails a CLI that ranks or writes a recall itself, and books tokens only outside recall and explain', () => {
    const call = (method: string): string => `export const f = (s: Store): void => s.${method}({});\n`;
    const hits = lint({
      'src/surface/cli/rank.ts':
        "import { rankRecall } from '../../api/recall/pipeline.js';\nexport const r = rankRecall;\n",
      'src/surface/cli/tenant.ts':
        "import { resolveTenantId } from '../server/boot.js';\nexport const t = resolveTenantId;\n",
      'src/surface/cli/bump.ts': call('bumpRecallStats'),
      'src/surface/cli/finish.ts': call('finishRecall'),
      'src/surface/cli/write.ts': call('writeEntry'),
      'src/surface/cli/recall.ts': call('recordTokens'),
      'src/surface/cli/recall-flags.ts': call('recordTokens'),
      'src/surface/cli/recall-block.ts': call('recordTokens'),
      'src/surface/cli/usage.ts': call('recordTokens'),
    });
    expect(hits.get('src/surface/cli/rank.ts')).toContain(IMPORT);
    expect(hits.get('src/surface/cli/tenant.ts')).toContain(IMPORT);
    for (const file of ['bump', 'finish', 'write', 'recall', 'recall-flags', 'recall-block']) {
      expect(hits.get(`src/surface/cli/${file}.ts`)).toEqual([PROPERTY]);
    }
    expect(hits.get('src/surface/cli/usage.ts')).toBeUndefined();
  });
});

describe('.oxlintrc.json store rules', () => {
  it('fails a store branch, a twin, SQL and BEGIN outside the data layer, and a surface that books a recall', () => {
    const hits = lint({
      'src/api/kind.ts': "export const k = (ctx: Ctx): number => (ctx.store.kind === 'mem' ? 1 : 2);\n",
      'src/api/ternary.ts': 'export const k = (store: Store | null): number => (store ? 1 : 2);\n',
      'src/api/twin.ts': 'export function readThroughStore(): number {\n  return 1;\n}\n',
      'src/api/sql.ts': "export const q = (db: Db): Row => db.prepare('SELECT 1');\n",
      'src/store/sqlite/sql.ts': "export const q = (db: Db): Row => db.prepare('SELECT 1');\n",
      'src/api/begin.ts': "export const begin = 'BEGIN IMMEDIATE';\n",
      'src/db/busy.ts': "export const begin = 'BEGIN IMMEDIATE';\n",
      'src/surface/server/label.ts': "export const b = (a: Api): void => a.recordTokens({}, 'recall');\n",
      'src/surface/server/other.ts': "export const b = (a: Api): void => a.recordTokens({}, 'remember');\n",
      'src/surface/mcp/note.ts': 'export const n = (s: Store): void => s.noteRecall();\n',
    });
    expect(hits.get('src/api/kind.ts')).toEqual(['boundaries(no-store-branch)']);
    expect(hits.get('src/api/ternary.ts')).toEqual(['boundaries(no-store-branch)']);
    expect(hits.get('src/api/twin.ts')).toEqual(['boundaries(no-twin-function)']);
    expect(hits.get('src/api/sql.ts')).toEqual([PROPERTY]);
    expect(hits.get('src/store/sqlite/sql.ts')).toBeUndefined();
    expect(hits.get('src/api/begin.ts')).toEqual(['boundaries(no-hand-transaction)']);
    expect(hits.get('src/db/busy.ts')).toBeUndefined();
    expect(hits.get('src/surface/server/label.ts')).toEqual(['boundaries(no-recall-ledger-label)']);
    expect(hits.get('src/surface/server/other.ts')).toBeUndefined();
    expect(hits.get('src/surface/mcp/note.ts')).toEqual([PROPERTY]);
  });
});

describe('.oxlintrc.json test env rule', () => {
  it('fails a test that writes process.env by hand, and passes reads, a child env object and tests/_helpers', () => {
    const hits = lint({
      'tests/assign.test.ts': "process.env.A = 'x';\nprocess.env[key] = 'y';\nprocess.env.B ??= 'z';\n",
      'tests/delete.test.ts': 'delete process.env.C;\ndelete process.env[key];\n',
      'tests/replace.test.ts': "Object.assign(process.env, { A: '1' });\nprocess.env = { ...process.env };\n",
      'tests/reads.test.ts': [
        'const home = process.env.HOME;',
        "const env = { ...process.env, A: '1' };",
        "const child = Object.assign({}, process.env, { B: '2' });",
        "vi.stubEnv('A', '1');",
      ].join('\n'),
      'tests/_helpers/env.ts': "process.env.A = 'x';\n",
    });
    const writes = (file: string): number =>
      (hits.get(file) ?? []).filter((code) => code === 'boundaries(no-env-write)').length;
    expect(writes('tests/assign.test.ts')).toBe(3);
    expect(writes('tests/delete.test.ts')).toBe(2);
    expect(writes('tests/replace.test.ts')).toBe(2);
    expect(writes('tests/reads.test.ts')).toBe(0);
    expect(writes('tests/_helpers/env.ts')).toBe(0);
  });
});

describe('.oxlintrc.json store-group and grant rules', () => {
  it('fails HippoStore and hasGroups in api and domain code, which take the groups they name', () => {
    const hits = lint({
      'src/api/whole.ts':
        "import type { HippoStore } from '../base/ports/store.js';\nexport const f = (s: HippoStore): HippoStore => s;\n",
      'src/domain/narrow.ts': "import { hasGroups } from '../base/ports/store.js';\nexport const n = hasGroups;\n",
    });
    expect(hits.get('src/api/whole.ts')).toContain(IMPORT);
    expect(hits.get('src/domain/narrow.ts')).toContain(IMPORT);
  });

  it('fails an unscoped hippo.db open in src, and passes it in the db files that make one', () => {
    const open = (name: string, from: string): string =>
      `import { ${name} } from '${from}';\nexport const o = ${name};\n`;
    const hits = lint({
      'src/store/sqlite/opens.ts': open('openHippoDb', '../../db/index.js'),
      'src/db/reads.ts': open('openHippoDbReadOnly', './open.js'),
      'src/db/deep/reads.ts': open('openHippoDb', '../open.js'),
      'src/db/grant.ts': open('openHippoDbReadOnly', './open.js'),
      'src/db/index.ts': "export { openHippoDb } from './open.js';\n",
    });
    expect(hits.get('src/store/sqlite/opens.ts')).toContain(IMPORT);
    expect(hits.get('src/db/reads.ts')).toContain(IMPORT);
    expect(hits.get('src/db/deep/reads.ts')).toContain(IMPORT);
    expect(hits.get('src/db/grant.ts')).toBeUndefined();
    expect(hits.get('src/db/index.ts')).toBeUndefined();
  });

  it('fails a hippo.db connection, session open or raw SQLite connection in src that skips the grant, and passes each where it is made', () => {
    const open = (name: string, from: string): string =>
      `import { ${name} } from '${from}';\nexport const o = ${name};\n`;
    const hits = lint({
      'src/store/sqlite/connects.ts': open('connectWithFacts', '../../db/connect.js'),
      'src/db/connects.ts': open('connectWithFacts', './connect.js'),
      'src/store/sqlite/session-opens.ts': open('SESSION_OPEN', '../../db/request-stores.js'),
      'src/db/session-opens.ts': open('SESSION_OPEN', './request-stores.js'),
      'src/db/grant.ts':
        open('connectWithFacts', './connect.js') + open('SESSION_OPEN', './request-stores.js').replace(' o ', ' p '),
      'src/db/request-stores.ts': open('connectWithFacts', './connect.js'),
      'src/store/sqlite/worker-jobs.ts': open('SESSION_OPEN', '../../db/request-stores.js'),
      'src/store/sqlite/raw-connects.ts': open('DatabaseSync', '../../db/sqlite.js'),
      'src/db/raw-connects.ts': open('DatabaseSync', './sqlite.js'),
      'src/db/connect.ts': open('DatabaseSync', './sqlite.js'),
      'src/db/continuity-tables.ts': open('DatabaseSync', './sqlite.js'),
    });
    for (const file of [
      'src/store/sqlite/connects.ts',
      'src/db/connects.ts',
      'src/store/sqlite/session-opens.ts',
      'src/db/session-opens.ts',
      'src/store/sqlite/raw-connects.ts',
      'src/db/raw-connects.ts',
    ]) {
      expect(hits.get(file), file).toContain(IMPORT);
    }
    expect(hits.get('src/db/grant.ts')).toBeUndefined();
    expect(hits.get('src/db/request-stores.ts')).toBeUndefined();
    expect(hits.get('src/store/sqlite/worker-jobs.ts')).toBeUndefined();
    expect(hits.get('src/db/connect.ts')).toBeUndefined();
    expect(hits.get('src/db/continuity-tables.ts')).toBeUndefined();
  });
});

const DEPCRUISE = join(REPO, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');

interface Violation {
  readonly from: string;
  readonly rule: { readonly name: string };
}

/** Runs the repo's depcruise rules over `files` in a fresh folder; the files each `rule` names. */
function cruise(files: Record<string, string>, rule: string): string[] {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-boundary-deps-')));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'nodenext' } }));
    const config = join(REPO, '.dependency-cruiser.cjs');
    const args = [DEPCRUISE, 'src', '--config', config, '--output-type', 'json'];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf-8' });
    // SAFETY: depcruise's json output carries summary.violations, each with its from path and rule name.
    const { summary } = JSON.parse(r.stdout) as { summary: { violations: Violation[] } };
    return summary.violations.filter((v) => v.rule.name === rule).map((v) => v.from);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('.dependency-cruiser.cjs grant rule', () => {
  it('fails a value import of db/grant.ts outside the adapter grant, and passes a type import', () => {
    const grant = 'export class DbGrant {}\nexport const mintDbGrant = (): DbGrant => new DbGrant();\n';
    const minted = cruise(
      {
        'src/db/grant.ts': grant,
        'src/store/sqlite/grant.ts':
          "import { mintDbGrant } from '../../db/grant.js';\nexport const g = mintDbGrant();\n",
        'src/store/sqlite/forged.ts':
          "import { mintDbGrant } from '../../db/grant.js';\nexport const g = mintDbGrant();\n",
        'src/store/sqlite/typed.ts':
          "import type { DbGrant } from '../../db/grant.js';\nexport const t = (g: DbGrant): DbGrant => g;\n",
      },
      'db-grant-mint',
    );
    expect(minted).toEqual(['src/store/sqlite/forged.ts']);
  });

  it('fails node:sqlite loaded anywhere but src/db/sqlite.ts and the file lock', () => {
    const raw =
      "import { DatabaseSync } from 'node:sqlite';\nexport const open = (p: string): unknown => new DatabaseSync(p);\n";
    const loaded = cruise(
      { 'src/db/sqlite.ts': raw, 'src/host/file-lock.ts': raw, 'src/store/sqlite/raw.ts': raw, 'src/db/raw.ts': raw },
      'sqlite-in-data-layer',
    );
    expect(loaded.sort()).toEqual(['src/db/raw.ts', 'src/store/sqlite/raw.ts']);
  });

  it('fails a dynamic import of a src/db module, which the grant lint ban cannot see', () => {
    const imported = cruise(
      {
        'src/db/connect.ts': 'export const connectWithFacts = (): number => 1;\n',
        'src/store/sqlite/late.ts':
          "export const open = async (): Promise<number> => (await import('../../db/connect.js')).connectWithFacts();\n",
        'src/store/sqlite/static.ts':
          "import { connectWithFacts } from '../../db/connect.js';\nexport const n = connectWithFacts();\n",
      },
      'db-dynamic-import',
    );
    expect(imported).toEqual(['src/store/sqlite/late.ts']);
  });
});

/** The files scripts/check-sqlite-loads.mjs names over `files` in a fresh folder. */
function sqliteLoads(files: Record<string, string>): string[] {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hippo-boundary-sqlite-')));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const script = join(REPO, 'scripts', 'check-sqlite-loads.mjs');
    const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf-8' });
    return [...r.stderr.matchAll(/^ {2}(src\/\S+):\d+ /gm)].map(([, file]) => file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('scripts/check-sqlite-loads.mjs', () => {
  it('fails node:sqlite through a renamed createRequire or getBuiltinModule, and a computed import in the data layer', () => {
    const loader = "const { DatabaseSync } = require('node:sqlite');\nexport { DatabaseSync };\n";
    const named = sqliteLoads({
      'src/db/sqlite.ts': loader,
      'src/host/file-lock.ts': loader,
      'src/db/wal-checkpointer.ts': "export const SOURCE = `const { DatabaseSync } = require('node:sqlite');`;\n",
      'src/store/sqlite/renamed.ts':
        "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport const m = load('node:sqlite');\n",
      'src/store/sqlite/builtin.ts': "export const m = process.getBuiltinModule('node:sqlite');\n",
      'src/store/sqlite/worker.ts': "export const SOURCE = `require('node:sqlite')`;\n",
      'src/db/computed.ts':
        "const where = '../db/connect.js';\nexport const open = async (): Promise<unknown> => import(where);\n",
      'src/db/literal.ts': "export const open = async (): Promise<unknown> => import('./connect.js');\n",
    });
    expect(named.sort()).toEqual([
      'src/db/computed.ts',
      'src/store/sqlite/builtin.ts',
      'src/store/sqlite/renamed.ts',
      'src/store/sqlite/worker.ts',
    ]);
  });
});
