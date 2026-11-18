// The init step that installs the local embedder beside a global hippo, so a default install
// recalls by meaning as well as by keyword while the package itself keeps no runtime dependencies.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import type { EmbeddingsConfig } from '../../base/config/config.js';
import { PACKAGE_ROOT } from '../../base/config/package-root.js';
import { isEmbeddingAvailable } from '../../base/embeddings/local.js';
import { envSkipEmbedderInstall } from '../../base/util/env.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';

/** Exact: a global install has no lockfile, so this pin is the one review gate on the tree. */
const EMBEDDER_PACKAGE = '@huggingface/transformers@4.3.2';
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const NPM_CLI = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
const PROJECT_ADD: ReadonlyArray<readonly [lockfile: string, command: string]> = [
  ['pnpm-lock.yaml', 'pnpm add'],
  ['yarn.lock', 'yarn add --ignore-scripts'],
  ['bun.lock', 'bun add'],
  ['bun.lockb', 'bun add'],
];

export type RunNode = (file: string, args: readonly string[], opts: ExecFileSyncOptions) => void;

/** What the step reads from the machine; tests pass stand-ins. */
export interface EmbedderInstallDeps {
  readonly run: RunNode;
  readonly installed: () => boolean;
  readonly exists: (file: string) => boolean;
  readonly packageRoot: string;
  readonly platform: NodeJS.Platform;
  readonly nodePath: string;
}

const MACHINE: EmbedderInstallDeps = {
  run: execFileSync,
  installed: isEmbeddingAvailable,
  exists: fs.existsSync,
  packageRoot: PACKAGE_ROOT,
  platform: process.platform,
  nodePath: process.execPath,
};

type Layout =
  | { readonly kind: 'npm-global'; readonly prefix: string }
  | { readonly kind: 'npx' }
  | { readonly kind: 'project'; readonly dir: string };

/** npm puts globals in `{prefix}/node_modules` on Windows and `{prefix}/lib/node_modules`
 * elsewhere, with no package.json above; pnpm, yarn, bun and npm projects are all projects. */
function layoutOf(deps: EmbedderInstallDeps): Layout {
  const parts = deps.packageRoot.split(/[\\/]/);
  if (parts.includes('_npx')) return { kind: 'npx' };
  const first = parts.indexOf('node_modules');
  if (first < 0) return { kind: 'project', dir: deps.packageRoot };
  const dir = parts.slice(0, first).join(path.sep) || path.sep;
  const direct = first === parts.length - 2;
  if (direct && !deps.exists(path.join(dir, 'package.json'))) {
    if (deps.platform === 'win32') return { kind: 'npm-global', prefix: dir };
    if (path.basename(dir) === 'lib') return { kind: 'npm-global', prefix: path.dirname(dir) };
  }
  return { kind: 'project', dir };
}

function adviceFor(layout: Layout, deps: EmbedderInstallDeps): string {
  if (layout.kind === 'npm-global') {
    return `run: npm install -g --ignore-scripts ${EMBEDDER_PACKAGE}`;
  }
  if (layout.kind === 'npx') {
    return 'install hippo globally (npm install -g hippo-memory), then run hippo init again';
  }
  const add =
    PROJECT_ADD.find(([lockfile]) => deps.exists(path.join(layout.dir, lockfile)))?.[1] ??
    'npm install --ignore-scripts';
  return `run \`${add} ${EMBEDDER_PACKAGE}\` in ${layout.dir}`;
}

/** How to install the local embedder where this hippo resolves it, as the end of a sentence. */
export function embedderInstallAdvice(deps: EmbedderInstallDeps = MACHINE): string {
  return adviceFor(layoutOf(deps), deps);
}

/** The npm that owns hippo's global folder, else the one shipped beside this node. */
function npmCliFor(prefix: string, deps: EmbedderInstallDeps): string | undefined {
  const lib = deps.platform === 'win32' ? '' : 'lib';
  const nodeHome = path.dirname(deps.nodePath);
  const beside = deps.platform === 'win32' ? nodeHome : path.join(path.dirname(nodeHome), 'lib');
  return [path.join(prefix, lib, NPM_CLI), path.join(beside, NPM_CLI)].find(deps.exists);
}

/** execFileSync puts npm's exit code on the error it throws; a kill or a failed start leaves none. */
function failureLine(error: Error): string {
  if (errorCode(error) === 'ETIMEDOUT') return 'npm ran for 10 minutes, so hippo stopped it.';
  if ('status' in error && Number.isInteger(error.status)) {
    return `npm stopped with exit code ${String(error.status)}; its error is above.`;
  }
  return `npm did not start (${error.message.split(/\r?\n/, 1)[0]}).`;
}

/** Installs the local embedder into hippo's own npm global folder, else prints how; never throws.
 * --ignore-scripts: the tree ships prebuilt binaries, so no transitive install script runs. */
export function installLocalEmbedder(
  embeddings: EmbeddingsConfig,
  deps: EmbedderInstallDeps = MACHINE,
): boolean {
  if (embeddings.enabled === false || (embeddings.provider ?? 'local') !== 'local') return false;
  if (deps.installed()) return false;
  if (envSkipEmbedderInstall()) {
    console.log('HIPPO_SKIP_EMBEDDER_INSTALL=1, so init did not install local embeddings.');
    return false;
  }
  const layout = layoutOf(deps);
  const npmCli = layout.kind === 'npm-global' ? npmCliFor(layout.prefix, deps) : undefined;
  if (layout.kind !== 'npm-global' || !npmCli) {
    console.log(`Embeddings are off. For recall by meaning, ${adviceFor(layout, deps)}`);
    return false;
  }
  console.log(
    `Installing local embeddings (${EMBEDDER_PACKAGE}, about 480 MB, and an 87 MB model on ` +
      'first use) for recall by meaning. This can take a few minutes; --no-embeddings skips it.',
  );
  try {
    deps.run(
      deps.nodePath,
      [
        npmCli,
        'install',
        '--global',
        '--prefix',
        layout.prefix,
        '--ignore-scripts',
        EMBEDDER_PACKAGE,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: INSTALL_TIMEOUT_MS },
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(errorMessage(err));
    log.info(`embedder install failed: ${error.message}`, errorFields(error));
    console.log(`${failureLine(error)} For recall by meaning, ${adviceFor(layout, deps)}`);
    return false;
  }
  if (!deps.installed()) {
    console.log(
      `npm finished, but hippo cannot find the package. For recall by meaning, ${adviceFor(layout, deps)}`,
    );
    return false;
  }
  console.log('Local embeddings are on.');
  return true;
}
