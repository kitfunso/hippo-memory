// No symbol a package.json export publishes reaches hippo.db's local tier: the TypeScript checker walks each one's type
// through members, parameters, returns and type arguments, and fails on a type declared in the tier port.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');
const TIER_PORT = /\/base\/ports\/hippo-db\.(d\.)?ts$/;
const posix = (p: string): string => p.split(sep).join('/');

/** `entry: name` for each symbol an entry exports whose type reaches a type the tier port declares, and `entry: no
 * declarations` for an entry with no file or no exports, so a missing build never passes unchecked. */
function tierReaches(root: string, entries: readonly string[]): string[] {
  const program = ts.createProgram(
    entries.map((e) => resolve(root, e)),
    { strict: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext },
  );
  const checker = program.getTypeChecker();
  const inPackage = posix(resolve(root)).toLowerCase() + '/';
  // A CI checkout keeps node_modules, TypeScript's lib included, inside the package; walking those members expands
  // generics such as Array<T> without end.
  const ownFile = (f: string): boolean => f.toLowerCase().startsWith(inPackage) && !f.includes('/node_modules/');
  const declaredIn = (symbol: ts.Symbol | undefined, test: (file: string) => boolean): boolean =>
    (symbol?.declarations ?? []).some((d) => test(posix(d.getSourceFile().fileName)));
  // Each instantiation of a generic is a new ts.Type, so members are walked once per declaration; a later instantiation
  // differs only by its type arguments, which are walked on their own.
  const reaches = (type: ts.Type, seen: Set<ts.Type | ts.Symbol>): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if ([type.aliasSymbol, type.getSymbol()].some((s) => declaredIn(s, (f) => TIER_PORT.test(f)))) return true;
    const inner: ts.Type[] = [...(type.aliasTypeArguments ?? [])];
    if (type.isUnionOrIntersection()) inner.push(...type.types);
    // `<T extends HippoDbTier>(s: T)` reaches the tier only through T's constraint.
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint !== undefined) inner.push(constraint);
    }
    if (type.flags & ts.TypeFlags.Object) {
      // SAFETY: TypeFlags.Object marks an ObjectType.
      const object = type as ts.ObjectType;
      if (object.objectFlags & ts.ObjectFlags.Reference) {
        // SAFETY: ObjectFlags.Reference marks a TypeReference.
        inner.push(...checker.getTypeArguments(object as ts.TypeReference));
      }
      // A type declared outside the package is data whose members the walk does not need.
      const declaration = type.aliasSymbol ?? type.getSymbol();
      if (declaration !== undefined && !seen.has(declaration) && declaredIn(declaration, ownFile)) {
        seen.add(declaration);
        for (const prop of checker.getPropertiesOfType(type)) inner.push(checker.getTypeOfSymbol(prop));
        for (const sig of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
          inner.push(checker.getReturnTypeOfSignature(sig), ...sig.parameters.map((p) => checker.getTypeOfSymbol(p)));
          inner.push(...(sig.getTypeParameters() ?? []));
          const narrowed = checker.getTypePredicateOfSignature(sig)?.type;
          if (narrowed !== undefined) inner.push(narrowed);
        }
        for (const info of checker.getIndexInfosOfType(type)) inner.push(info.type);
      }
    }
    return inner.some((t) => reaches(t, seen));
  };
  const hits: string[] = [];
  for (const entry of entries) {
    const file = program.getSourceFile(resolve(root, entry));
    const moduleSymbol = file && checker.getSymbolAtLocation(file);
    const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
    if (exports.length === 0) hits.push(`${entry}: no declarations`);
    for (const exported of exports) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const types = [checker.getTypeOfSymbol(symbol)];
      if (symbol.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Class)) {
        types.push(checker.getDeclaredTypeOfSymbol(symbol));
      }
      if (types.some((t) => reaches(t, new Set())) || declaredIn(symbol, (f) => TIER_PORT.test(f))) {
        hits.push(`${entry}: ${exported.name}`);
      }
    }
  }
  return hits.sort();
}

/** The .d.ts file of each entry package.json exports. */
function publishedEntries(): string[] {
  // SAFETY: package.json's exports map each subpath to one built .js file.
  const { exports } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return Object.values(exports).map((js) => js.replace(/^\.\//, '').replace(/\.js$/, '.d.ts'));
}

const TIER_FIXTURE =
  'export interface HippoDbRepos { readonly rows: { read(): Promise<string> } }\n' +
  'export interface HippoDbTier { readonly hippoDb: HippoDbRepos }\n';

/** tierReaches over `entries` in a scratch package holding `files`. */
function reachesIn(files: Readonly<Record<string, string>>, entries: readonly string[]): string[] {
  const root = mkdtempSync(join(tmpdir(), 'hippo-published-tier-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return tierReaches(root, entries);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('published symbols and the local tier', () => {
  it('no symbol any package.json export publishes reaches a type the tier port declares', () => {
    const entries = publishedEntries();
    expect(entries).toContain('dist/entry/store-kit.d.ts');
    expect(tierReaches(REPO, entries)).toEqual([]);
  });

  it('fails a symbol that returns, narrows to, aliases or constrains a type parameter to the tier type, an entry with no exports or no file, and passes data, generics and recursive types', () => {
    const files = {
      'base/ports/hippo-db.d.ts': TIER_FIXTURE,
      'entry.d.ts': [
        "import type { HippoDbTier } from './base/ports/hippo-db.js';",
        'type Wrapped = { readonly inner: Promise<readonly HippoDbTier[]> };',
        'export type Leaky = Wrapped;',
        'export declare function open(): HippoDbTier;',
        'export declare function isTier(store: object): store is HippoDbTier;',
        'export declare function narrow<T extends HippoDbTier>(s: T): void;',
        'export declare function clean(at: Date): Promise<number>;',
        'export declare function first<T>(rows: readonly T[]): T;',
        'export interface Chain { readonly next?: Chain; readonly value: number }',
        // As tsc emits it: without `export {}` a .d.ts exports every top-level declaration, Wrapped too.
        'export {};',
      ].join('\n'),
      'empty.d.ts': 'export {};\n',
    };
    expect(reachesIn(files, ['entry.d.ts', 'empty.d.ts', 'missing.d.ts'])).toEqual([
      'empty.d.ts: no declarations',
      'entry.d.ts: Leaky',
      'entry.d.ts: isTier',
      'entry.d.ts: narrow',
      'entry.d.ts: open',
      'missing.d.ts: no declarations',
    ]);
  });

  it('reads a node_modules type only through its type arguments, so one that expands without end still ends', () => {
    const files = {
      'base/ports/hippo-db.d.ts': TIER_FIXTURE,
      'node_modules/deep/index.d.ts': 'export interface Deep<T> { readonly value: T; next(): Deep<T[]> }\n',
      'entry.d.ts': [
        "import type { HippoDbTier } from './base/ports/hippo-db.js';",
        "import type { Deep } from './node_modules/deep/index.js';",
        'export declare function numbers(): Deep<number>;',
        'export declare function tiers(): Deep<HippoDbTier>;',
      ].join('\n'),
    };
    expect(reachesIn(files, ['entry.d.ts'])).toEqual(['entry.d.ts: tiers']);
  });

  it('walks the members of a self-expanding generic declared in the package once, so it ends and still finds the tier', () => {
    const files = {
      'base/ports/hippo-db.d.ts': TIER_FIXTURE,
      'deep.d.ts': 'export interface Deep<T> { readonly value: T; next(): Deep<T[]> }\n',
      'entry.d.ts': [
        "import type { HippoDbTier } from './base/ports/hippo-db.js';",
        "import type { Deep } from './deep.js';",
        'export declare function numbers(): Deep<number>;',
        'export declare function tiers(): Deep<HippoDbTier>;',
      ].join('\n'),
    };
    expect(reachesIn(files, ['entry.d.ts'])).toEqual(['entry.d.ts: tiers']);
  });
});
