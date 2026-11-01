import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'checks', 'check-store-port.mjs');

type Run = { status: number | null; stdout: string; stderr: string; sites: string[] };

/** The whole stderr of a run that could not read a root of the store's types, for the reasons `sites`. */
const UNREAD = (...sites: string[]): string =>
  "The scan could not read a root of the store's types, so the types it reaches went unchecked:\n" +
  sites.map((site) => `  ${site}\n`).join('') +
  'Point STORE_ROOT or TIER_ROOT in scripts/lib/port-type-facts.mjs at the interface, and type each repository by a' +
  ' declared interface.\n';

const PKG = { 'package.json': '{ "name": "hippo-memory" }\n' };
const STORE = { 'src/base/ports/store.ts': 'export interface HippoStore { readonly kind: string }\n' };

/** A tier port listing the one repository `Rows`, declared in src/base/records/rows.ts as `body`. */
const tierOf = (body: string) => ({
  'src/base/ports/hippo-db.ts':
    "import type { Rows } from '../records/rows.js';\nexport interface HippoDbRepos { readonly rows: Rows }\n",
  'src/base/records/rows.ts': body,
});

function runOn(files: Record<string, string>): Run {
  const root = mkdtempSync(join(tmpdir(), 'hippo-store-port-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
    const sites = r.stderr
      .split('\n')
      .filter((l) => l.startsWith('  '))
      .map((l) => l.trim());
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, sites };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('check-store-port.mjs', () => {
  it('fails on a port method parameter that holds a function, through an alias, a union member, a property and an import', () => {
    const r = runOn({
      'src/base/ports/store.ts': [
        "import type { Fate } from './store/fate.js';",
        'export type Protect = (id: string) => string | undefined;',
        'export interface Plain { readonly id: string; readonly at: Date }',
        'export interface Group {',
        '  visit(each: (row: Plain) => void): void;',
        '  repair(tenantId: string, protect: Protect): void;',
        '  resolve(fate: Fate): void;',
        '  read(rows: readonly Plain[], opts: { readonly limit: number }): Promise<Plain[]>;',
        '  run<T>(work: T): T;',
        '}',
      ].join('\n'),
      'src/base/ports/store/fate.ts':
        "export type Fate = { readonly kind: 'weaken' } | { readonly kind: 'reject'; readonly inReach: (scope: string) => boolean };\n",
      'src/base/ports/store/later.ts':
        'export interface Later { readonly every: { readonly on: { tick(): void } } }\nexport interface G { start(later: Later): void }\n',
      'src/api/a.ts': 'export interface NotPort { visit(each: () => void): void }\n',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('A port or local-tier method takes a parameter whose type holds a function');
    expect(r.sites.sort()).toEqual([
      'src/base/ports/store.ts:5 Group.visit(each)',
      'src/base/ports/store.ts:6 Group.repair(protect)',
      'src/base/ports/store.ts:7 Group.resolve(fate.inReach)',
      'src/base/ports/store/later.ts:2 G.start(later.every.on.tick)',
    ]);
  });

  it('leaves out a type the store only receives, whose function the taking method already names', () => {
    const r = runOn({
      'src/base/ports/store.ts': [
        'export interface Source { read(sink: (row: string) => void): void }',
        'export interface Group { take(source: Source): void; open(): Promise<Opened> }',
        'export interface Opened { each(visit: () => void): void }',
        'export interface HippoStore { readonly group: Group }',
      ].join('\n'),
    });
    expect(r.status).toBe(1);
    expect(r.sites.sort()).toEqual([
      'src/base/ports/store.ts:2 Group.take(source.read)',
      'src/base/ports/store.ts:3 Opened.each(visit)',
    ]);
  });

  it('fails on a local-tier method parameter that holds a function, and leaves out a records type no repository lists', () => {
    const r = runOn(
      tierOf(
        [
          'export interface Row { readonly at: Date; readonly hooks: { readonly onRow: () => void } }',
          'export interface Rows {',
          '  visit(each: (row: string) => void): Promise<void>;',
          '  read(tenantId: string, at: Date): Promise<string>;',
          '  watch(row: Row): Promise<void>;',
          '}',
          'export interface Unlisted { visit(each: () => void): void }',
        ].join('\n'),
      ),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('A port or local-tier method takes a parameter whose type holds a function');
    expect(r.sites.sort()).toEqual([
      'src/base/records/rows.ts:3 Rows.visit(each)',
      'src/base/records/rows.ts:5 Rows.watch(row.hooks.onRow)',
    ]);
  });

  it('reads every overload of a local-tier method, at the overload that takes the function', () => {
    const r = runOn(
      tierOf(
        [
          'export interface Rows {',
          '  read(id: string): Promise<string>;',
          '  read(id: string, each: (row: string) => void): Promise<void>;',
          '}',
        ].join('\n'),
      ),
    );
    expect(r.status).toBe(1);
    expect(r.sites).toEqual(['src/base/records/rows.ts:3 Rows.read(each)']);
  });

  it('reads a function inside a generic declared outside src, and passes one that holds only data', () => {
    const r = runOn(
      tierOf(
        [
          'type Hook = () => void;',
          'export interface Rows {',
          '  table(hooks: Record<string, () => void>): Promise<void>;',
          '  keyed(hooks: Map<string, Hook>): Promise<void>;',
          '  later(hook: Promise<Hook>): Promise<void>;',
          '  plain(rows: Map<string, Date>, at: Promise<number>): Promise<void>;',
          '}',
        ].join('\n'),
      ),
    );
    expect(r.status).toBe(1);
    expect(r.sites.sort()).toEqual([
      'src/base/records/rows.ts:3 Rows.table(hooks)',
      'src/base/records/rows.ts:4 Rows.keyed(hooks)',
      'src/base/records/rows.ts:5 Rows.later(hook)',
    ]);
  });

  it('fails and names each store tenant a caller can leave out, as a parameter or an argument property, and passes the rest', () => {
    const r = runOn({
      'src/base/ports/store.ts': [
        "import type { Opts } from './store/opts.js';",
        'export interface Group {',
        '  page(tenantId?: string): void;',
        '  list(query: Opts): void;',
        '  named(tenantId: string | typeof ALL): void;',
        '}',
      ].join('\n'),
      'src/base/ports/store/opts.ts':
        'export type Opts = Base & { limit: number };\ninterface Base { tenant: string | null }\n',
      'src/store/sqlite/reads.ts': [
        "export function read(db: any, tenantId: string | undefined) { return db.prepare('SELECT 1').get(); }",
        "export function rows(db: any, { tenantId = 'x' }: { tenantId: string }) { return db.prepare('SELECT 2').get(); }",
        "export function ok(db: any, tenantId: string, row: { tenant_id?: string }) { return db.prepare('SELECT 3').get(); }",
      ].join('\n'),
      'src/api/loose.ts': 'export function f(tenantId?: string) {}\n',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('A store function or port method can be called without its tenant');
    expect(r.stderr).toContain('src/base/ports/store.ts:3 page(tenantId: tenantId)');
    expect(r.stderr).toContain('src/base/ports/store.ts:4 list(query: Base.tenant)');
    expect(r.stderr).toContain('src/store/sqlite/reads.ts:1 read(tenantId: tenantId)');
    expect(r.stderr).toContain('src/store/sqlite/reads.ts:2 rows(');
    expect(r.stderr).not.toContain(' named(');
    expect(r.stderr).not.toContain(' ok(');
    expect(r.stderr).not.toContain('src/api/loose.ts');
  });

  it('passes a port that takes data and required tenants', () => {
    const r = runOn({
      'src/base/ports/store.ts':
        'export interface Group { read(tenantId: string, opts: { readonly limit: number }): void }\n',
    });
    expect(r.status, r.stderr).toBe(0);
  });

  it("fails in hippo-memory's own folder when a root is gone, under its own heading and fix", () => {
    const noTier = runOn({ ...PKG, ...STORE });
    const renamed = runOn({ ...PKG, 'src/base/ports/hippo-db.ts': 'export interface LocalRepos { readonly n: 1 }\n' });
    expect([noTier.status, renamed.status]).toEqual([1, 1]);
    expect(noTier.stderr).toBe(UNREAD('src/base/ports/hippo-db.ts declares no HippoDbRepos'));
    expect(renamed.stderr).toBe(
      UNREAD('src/base/ports/store.ts declares no HippoStore', 'src/base/ports/hippo-db.ts declares no HippoDbRepos'),
    );
  });

  it("fails in hippo-memory's own folder on a tier that lists no repository, or one typed as no declared interface", () => {
    const empty = runOn({ ...PKG, ...STORE, 'src/base/ports/hippo-db.ts': 'export interface HippoDbRepos {}\n' });
    const blind = runOn({
      ...PKG,
      ...STORE,
      'src/base/ports/hippo-db.ts': [
        'interface Real { read(id: string): Promise<string> }',
        'export interface HippoDbRepos {',
        '  readonly real: Real;',
        '  readonly typedAny: any;',
        '  readonly gone: Gone;',
        '}',
      ].join('\n'),
    });
    expect([empty.status, blind.status]).toEqual([1, 1]);
    expect(empty.stderr).toBe(UNREAD('src/base/ports/hippo-db.ts HippoDbRepos lists no repository'));
    expect(blind.stderr).toBe(
      UNREAD(
        'src/base/ports/hippo-db.ts:4 HippoDbRepos.typedAny names no interface the scan can read',
        'src/base/ports/hippo-db.ts:5 HippoDbRepos.gone names no interface the scan can read',
      ),
    );
  });

  it('passes on the real repo', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
