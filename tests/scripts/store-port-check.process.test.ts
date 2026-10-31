import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'checks', 'check-store-port.mjs');

type Run = { status: number | null; stdout: string; stderr: string; sites: string[] };

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
    expect(r.stderr).toContain('A port method takes a parameter whose type holds a function');
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

  it('fails on a local-tier method parameter that holds a function, read from the types hippoDbRepos infers', () => {
    const r = runOn({
      'src/store/sqlite/hippo-db.ts': [
        'export interface Row { readonly at: Date; readonly hooks: { readonly onRow: () => void } }',
        'export function hippoDbRepos() {',
        '  return {',
        '    rows: {',
        '      visit(each: (row: string) => void): void {},',
        '      read(tenantId: string, at: Date): string { return tenantId; },',
        '      watch(row: Row): void {},',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("A method of hippo.db's local tier takes a parameter whose type holds a function");
    expect(r.sites.sort()).toEqual([
      'src/store/sqlite/hippo-db.ts:5 rows.visit(each)',
      'src/store/sqlite/hippo-db.ts:7 rows.watch(row.hooks.onRow)',
    ]);
  });

  it('reads every overload of a local-tier method, at the overload that takes the function', () => {
    const r = runOn({
      'src/store/sqlite/hippo-db.ts': [
        'function read(id: string): string;',
        'function read(id: string, each: (row: string) => void): void;',
        'function read(id: string, each?: (row: string) => void): string | void { return id; }',
        'export function hippoDbRepos() {',
        '  return { rows: { read } };',
        '}',
      ].join('\n'),
    });
    expect(r.status).toBe(1);
    expect(r.sites).toEqual(['src/store/sqlite/hippo-db.ts:2 rows.read(each)']);
  });

  it('reads a function inside a generic declared outside src, and passes one that holds only data', () => {
    const r = runOn({
      'src/store/sqlite/hippo-db.ts': [
        'type Hook = () => void;',
        'export function hippoDbRepos() {',
        '  return {',
        '    rows: {',
        '      table(hooks: Record<string, () => void>): void {},',
        '      keyed(hooks: Map<string, Hook>): void {},',
        '      later(hook: Promise<Hook>): void {},',
        '      plain(rows: Map<string, Date>, at: Promise<number>): void {},',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    });
    expect(r.status).toBe(1);
    expect(r.sites.sort()).toEqual([
      'src/store/sqlite/hippo-db.ts:5 rows.table(hooks)',
      'src/store/sqlite/hippo-db.ts:6 rows.keyed(hooks)',
      'src/store/sqlite/hippo-db.ts:7 rows.later(hook)',
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

  it('passes on the real repo', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
