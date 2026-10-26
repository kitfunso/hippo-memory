#!/usr/bin/env node
// Builds one CycloneDX SBOM of what the npm tarball ships: root runtime
// components plus the ui root plus ui runtime components.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEV_PROPERTY = 'cdx:npm:package:development';

/** Components without npm's `cdx:npm:package:development` = `true` property. */
export function runtimeComponents(bom) {
  return (bom.components ?? []).filter(
    (c) => !(c.properties ?? []).some((p) => p.name === DEV_PROPERTY && p.value === 'true'),
  );
}

/** Merges root + ui CycloneDX BOMs into one runtime-only document: relabels the
 *  ui root (npm names it after the folder) uiName and links it from root. */
export function mergeRuntimeBoms(rootBom, uiBom, rootName, uiName) {
  const rootRef = rootBom.metadata.component['bom-ref'];
  const uiRootComponent = { ...uiBom.metadata.component, name: uiName };
  const uiRootRef = uiRootComponent['bom-ref'];

  const components = [];
  const seenComponents = new Set();
  for (const c of [...runtimeComponents(rootBom), uiRootComponent, ...runtimeComponents(uiBom)]) {
    if (seenComponents.has(c['bom-ref'])) continue;
    seenComponents.add(c['bom-ref']);
    components.push(c);
  }

  // The root's own bom-ref survives too: it is the document subject, not a components[] entry.
  const survivors = new Set([rootRef, ...components.map((c) => c['bom-ref'])]);
  const dependencies = [];
  const seenDeps = new Set();
  for (const dep of [...(rootBom.dependencies ?? []), ...(uiBom.dependencies ?? [])]) {
    if (seenDeps.has(dep.ref) || !survivors.has(dep.ref)) continue;
    seenDeps.add(dep.ref);
    const dependsOn = (dep.dependsOn ?? []).filter((ref) => survivors.has(ref));
    if (dep.ref === rootRef) dependsOn.push(uiRootRef);
    dependencies.push({ ref: dep.ref, dependsOn });
  }

  return {
    ...rootBom,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: { ...rootBom.metadata, component: { ...rootBom.metadata.component, name: rootName } },
    components,
    dependencies,
  };
}

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function readName(pkgJsonPath) {
  return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).name;
}

// npm 11.17's --omit dev on ui/ wrongly drops react, react-dom and scheduler; take the
// full lockfile-only BOM instead and filter by the development property ourselves.
function npmSbom(dir) {
  const result = spawnSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--package-lock-only', '--offline'], {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`npm sbom failed in ${dir}:\n${result.stderr || result.error?.message || 'unknown error'}`);
  }
  return JSON.parse(result.stdout);
}

function main() {
  const dir = flag('--dir', '.');
  const out = flag('--out', null);
  const rootName = readName(join(dir, 'package.json'));
  const uiName = readName(join(dir, 'ui', 'package.json'));
  const merged = mergeRuntimeBoms(npmSbom(dir), npmSbom(join(dir, 'ui')), rootName, uiName);
  const json = JSON.stringify(merged, null, 2) + '\n';
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}

// CLI main. Guarded so importing this module (e.g. from the test) does NOT run it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
