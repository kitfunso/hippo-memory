// scripts/sbom.mjs: the release SBOM lists what the npm tarball ships (root
// runtime components plus the ui root plus ui runtime components), never dev deps.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// Imported from the .mjs script; the CLI main is guarded so this import does NOT run it.
import { runtimeComponents, mergeRuntimeBoms } from '../scripts/sbom.mjs';

interface CdxProperty { readonly name: string; readonly value: string }
interface CdxComponent {
  readonly 'bom-ref': string;
  readonly name: string;
  readonly version: string;
  readonly properties: readonly CdxProperty[];
}
interface CdxDependency { readonly ref: string; readonly dependsOn: readonly string[] }
interface CdxBom {
  readonly specVersion: string;
  readonly metadata: { readonly component: CdxComponent };
  readonly components: readonly CdxComponent[];
  readonly dependencies: readonly CdxDependency[];
}

function comp(ref: string, dev = false): CdxComponent {
  const properties = dev ? [{ name: 'cdx:npm:package:development', value: 'true' }] : [];
  return { 'bom-ref': ref, name: ref.split('@')[0], version: ref.split('@')[1], properties };
}

describe('runtimeComponents', () => {
  it('drops components npm marked development, keeps the rest', () => {
    const bom = { components: [comp('runtime-dep@1.0.0'), comp('dev-dep@2.0.0', true)] };
    expect(runtimeComponents(bom).map((c: CdxComponent) => c['bom-ref'])).toEqual(['runtime-dep@1.0.0']);
  });
});

describe('mergeRuntimeBoms', () => {
  // shared-dep sits in both BOMs, runtime-dep depends on a dev package and on one in neither BOM,
  // and dev-dep / ui-dev must not survive the merge.
  const rootBom: CdxBom = {
    specVersion: '1.5',
    metadata: { component: comp('root-pkg@1.0.0') },
    components: [comp('runtime-dep@1.0.0'), comp('dev-dep@2.0.0', true), comp('shared-dep@3.0.0')],
    dependencies: [
      { ref: 'root-pkg@1.0.0', dependsOn: ['runtime-dep@1.0.0', 'dev-dep@2.0.0'] },
      { ref: 'runtime-dep@1.0.0', dependsOn: ['dev-dep@2.0.0', 'ghost@9.9.9'] },
      { ref: 'dev-dep@2.0.0', dependsOn: [] },
      { ref: 'shared-dep@3.0.0', dependsOn: [] },
    ],
  };
  const uiBom: CdxBom = {
    specVersion: '1.5',
    // npm names metadata.component after the folder, e.g. "ui" not the package name.
    metadata: { component: { ...comp('ui-pkg@0.1.0'), name: 'ui' } },
    components: [comp('ui-runtime@1.0.0'), comp('shared-dep@3.0.0'), comp('ui-dev@2.0.0', true)],
    dependencies: [
      { ref: 'ui-pkg@0.1.0', dependsOn: ['ui-runtime@1.0.0', 'shared-dep@3.0.0', 'ui-dev@2.0.0'] },
      { ref: 'ui-runtime@1.0.0', dependsOn: [] },
      { ref: 'shared-dep@3.0.0', dependsOn: [] },
      { ref: 'ui-dev@2.0.0', dependsOn: [] },
    ],
  };
  // SAFETY: mergeRuntimeBoms is untyped JS; its return shape matches CdxBom.
  const merged = mergeRuntimeBoms(rootBom, uiBom, 'root-name', 'ui-name') as CdxBom;
  const refs = merged.components.map((c) => c['bom-ref']);
  const dep = (ref: string): CdxDependency => merged.dependencies.find((d) => d.ref === ref)!;

  it('drops both dev components, keeps every runtime one', () => {
    expect(refs).not.toContain('dev-dep@2.0.0');
    expect(refs).not.toContain('ui-dev@2.0.0');
    expect(refs).toEqual(expect.arrayContaining(['runtime-dep@1.0.0', 'ui-runtime@1.0.0', 'shared-dep@3.0.0']));
  });

  it('de-dupes the shared bom-ref to one components[] entry', () => {
    expect(refs.filter((r) => r === 'shared-dep@3.0.0')).toHaveLength(1);
  });

  it('de-dupes the shared dependency entry to one, and strips dangling dependsOn', () => {
    expect(merged.dependencies.filter((d) => d.ref === 'shared-dep@3.0.0')).toHaveLength(1);
    // dev-dep and ghost were runtime-dep's only dependsOn entries; both are non-survivors.
    expect(dep('runtime-dep@1.0.0').dependsOn).toEqual([]);
  });

  it('renames metadata.component to rootName', () => {
    expect(merged.metadata.component.name).toBe('root-name');
    expect(merged.metadata.component['bom-ref']).toBe('root-pkg@1.0.0');
  });

  it('carries the ui root as a component named uiName, linked from the root entry', () => {
    const uiRoot = merged.components.find((c) => c['bom-ref'] === 'ui-pkg@0.1.0');
    expect(uiRoot?.name).toBe('ui-name');
    expect(dep('root-pkg@1.0.0').dependsOn).toContain('ui-pkg@0.1.0');
    expect(dep('ui-pkg@0.1.0').dependsOn).toEqual(expect.arrayContaining(['ui-runtime@1.0.0', 'shared-dep@3.0.0']));
  });
});

describe('scripts/sbom.mjs CLI (real repo, spawns npm)', () => {
  const SBOM_JS = resolve(__dirname, '..', 'scripts', 'sbom.mjs');
  const REPO_ROOT = resolve(__dirname, '..');

  it('lists react, react-dom and three; never @types/three or a dev component; every ref resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbom-cli-'));
    try {
      const out = join(dir, 'out.cdx.json');
      execFileSync(process.execPath, [SBOM_JS, '--dir', REPO_ROOT, '--out', out], { encoding: 'utf8' });
      // SAFETY: sbom.mjs's own output; shape matches CdxBom.
      const bom = JSON.parse(readFileSync(out, 'utf8')) as CdxBom;
      const names = bom.components.map((c) => c.name);

      for (const want of ['react', 'react-dom', 'three']) {
        expect(names, `expected ${want} in the merged runtime SBOM (npm's sbom output may have changed)`).toContain(want);
      }
      expect(names, '@types/three should stay a devDependency and be absent here').not.toContain('@types/three');
      const devComponent = bom.components.find((c) => c.properties.some((p) => p.name === 'cdx:npm:package:development' && p.value === 'true'));
      expect(devComponent, `found a dev component npm's development property did not filter: ${devComponent?.['bom-ref']}`).toBeUndefined();

      const validRefs = new Set([bom.metadata.component['bom-ref'], ...bom.components.map((c) => c['bom-ref'])]);
      const dangling: string[] = [];
      for (const d of bom.dependencies) {
        if (!validRefs.has(d.ref)) dangling.push(`dependency ref ${d.ref}`);
        for (const r of d.dependsOn) if (!validRefs.has(r)) dangling.push(`${d.ref} -> ${r}`);
      }
      expect(dangling, `dangling refs (npm's cyclonedx shape may differ on this npm version): ${dangling.join(', ')}`).toEqual([]);

      const uiRef = bom.components.find((c) => c.name === 'hippo-brain-observatory')?.['bom-ref'];
      const rootEntry = bom.dependencies.find((d) => d.ref === bom.metadata.component['bom-ref']);
      expect(rootEntry?.dependsOn, 'the package must list the dashboard it bundles').toContain(uiRef);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
