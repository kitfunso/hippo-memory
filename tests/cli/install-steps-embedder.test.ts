// The embedder install reaches npm through a stand-in runner, so no test downloads the package.
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type EmbeddingsConfig } from '../../src/base/config/config.js';
import {
  embedderInstallAdvice,
  installLocalEmbedder,
  type EmbedderInstallDeps,
  type RunNode,
} from '../../src/surface/cli/embedder-install.js';

const PKG = '@huggingface/transformers@4.3.2';
const NPM_CLI = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
const GLOBAL_ADVICE = `run: npm install -g --ignore-scripts ${PKG}`;
const at = (p: string): string => path.resolve(p);

interface Call {
  readonly file: string;
  readonly args: readonly string[];
  readonly opts: Parameters<RunNode>[2];
}

interface Over {
  readonly installedBefore?: boolean;
  readonly installedAfter?: boolean;
  readonly fail?: Error;
  readonly platform?: NodeJS.Platform;
  readonly packageRoot?: string;
  readonly nodePath?: string;
  readonly files?: readonly string[];
}

interface Machine {
  readonly calls: Call[];
  readonly deps: EmbedderInstallDeps;
}

const LINUX_ROOT = at('/usr/lib/node_modules/hippo-memory');
const LINUX_NPM = path.join(at('/usr/lib'), NPM_CLI);

function machine(over: Over): Machine {
  const calls: Call[] = [];
  let installed = over.installedBefore ?? false;
  const run: RunNode = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (over.fail) throw over.fail;
    installed = over.installedAfter ?? true;
  };
  const files = new Set((over.files ?? [LINUX_NPM]).map((p) => path.resolve(p)));
  const deps: EmbedderInstallDeps = {
    run,
    installed: () => installed,
    exists: (file) => files.has(path.resolve(file)),
    packageRoot: over.packageRoot ?? LINUX_ROOT,
    platform: over.platform ?? 'linux',
    nodePath: over.nodePath ?? at('/usr/bin/node'),
  };
  return { calls, deps };
}

/** An execFileSync failure as Node builds it: npm's own output went to the terminal. */
function npmExit(status: number): Error {
  return Object.assign(new Error(`Command failed: node npm-cli.js install --global ${PKG}`), {
    status,
    stdout: null,
    stderr: null,
  });
}

const local: EmbeddingsConfig = DEFAULT_CONFIG.embeddings;
const said = (): string[] => vi.mocked(console.log).mock.calls.map(([line]) => String(line));
const installArgs = (cli: string, prefix: string): readonly string[] => [
  cli,
  'install',
  '--global',
  '--prefix',
  prefix,
  '--ignore-scripts',
  PKG,
];

describe('installLocalEmbedder', () => {
  beforeEach(() => {
    vi.stubEnv('HIPPO_SKIP_EMBEDDER_INSTALL', undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("installs into hippo's own prefix with the npm there, no shell and no install scripts", () => {
    const { calls, deps } = machine({});
    expect(installLocalEmbedder(local, deps)).toBe(true);
    expect(calls.map(({ file, args }) => [file, args])).toEqual([
      [at('/usr/bin/node'), installArgs(LINUX_NPM, at('/usr'))],
    ]);
    expect(calls[0]!.opts).toEqual({ stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000 });
    expect(said().at(-1)).toBe('Local embeddings are on.');
  });

  it('on Windows takes {prefix}/node_modules and the npm beside node.exe', () => {
    const prefix = at('/Users/u/AppData/Roaming/npm');
    const nodeExe = at('/Program Files/nodejs/node.exe');
    const besideNode = path.join(at('/Program Files/nodejs'), NPM_CLI);
    const { calls, deps } = machine({
      platform: 'win32',
      packageRoot: path.join(prefix, 'node_modules', 'hippo-memory'),
      nodePath: nodeExe,
      files: [besideNode],
    });
    expect(installLocalEmbedder(local, deps)).toBe(true);
    expect(calls.map(({ file, args }) => [file, args])).toEqual([[nodeExe, installArgs(besideNode, prefix)]]);
  });

  it("on Unix falls back to the npm in node's own lib folder", () => {
    const fromNode = path.join(at('/opt/node/lib'), NPM_CLI);
    const { calls, deps } = machine({ nodePath: at('/opt/node/bin/node'), files: [fromNode] });
    expect(installLocalEmbedder(local, deps)).toBe(true);
    expect(calls[0]!.args[0]).toBe(fromNode);
  });

  it('prints the command when no npm can be found', () => {
    const { calls, deps } = machine({ files: [] });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(said()).toEqual([`Embeddings are off. For recall by meaning, ${GLOBAL_ADVICE}`]);
  });

  it('runs nothing and says nothing when an embedder is already installed, even with the skip set', () => {
    vi.stubEnv('HIPPO_SKIP_EMBEDDER_INSTALL', '1');
    const { calls, deps } = machine({ installedBefore: true });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(said()).toEqual([]);
  });

  it.each([
    ['embeddings are disabled', { ...local, enabled: false }],
    ['an API embedder is configured', { ...local, provider: 'openai' as const }],
  ])('runs nothing when %s', (_why, config) => {
    const { calls, deps } = machine({});
    expect(installLocalEmbedder(config, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('runs nothing when HIPPO_SKIP_EMBEDDER_INSTALL=1, and says so', () => {
    vi.stubEnv('HIPPO_SKIP_EMBEDDER_INSTALL', '1');
    const { calls, deps } = machine({});
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(said()).toEqual(['HIPPO_SKIP_EMBEDDER_INSTALL=1, so init did not install local embeddings.']);
  });

  it.each([
    [
      'npx, whose cache npm cannot install into',
      '/home/u/.npm/_npx/ab12/node_modules/hippo-memory',
      [],
      'install hippo globally (npm install -g hippo-memory), then run hippo init again',
    ],
    [
      'an npm project',
      '/work/app/node_modules/hippo-memory',
      ['/work/app/package.json'],
      `run \`npm install --ignore-scripts ${PKG}\` in ${at('/work/app')}`,
    ],
    [
      'a pnpm project, whose store folder has no package.json',
      '/work/app/node_modules/.pnpm/hippo-memory@1.0.0/node_modules/hippo-memory',
      ['/work/app/package.json', '/work/app/pnpm-lock.yaml'],
      `run \`pnpm add ${PKG}\` in ${at('/work/app')}`,
    ],
    [
      'a yarn global',
      '/home/u/.config/yarn/global/node_modules/hippo-memory',
      ['/home/u/.config/yarn/global/package.json', '/home/u/.config/yarn/global/yarn.lock'],
      `run \`yarn add --ignore-scripts ${PKG}\` in ${at('/home/u/.config/yarn/global')}`,
    ],
    [
      'a Unix node_modules that is not under lib/',
      '/opt/tools/node_modules/hippo-memory',
      [],
      `run \`npm install --ignore-scripts ${PKG}\` in ${at('/opt/tools')}`,
    ],
    [
      'a source checkout',
      '/work/hippo-memory',
      [],
      `run \`npm install --ignore-scripts ${PKG}\` in ${at('/work/hippo-memory')}`,
    ],
  ])('prints, never installs, for %s', (_why, root, manifests, advice) => {
    const { calls, deps } = machine({ packageRoot: at(root), files: [LINUX_NPM, ...manifests] });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(said()).toEqual([`Embeddings are off. For recall by meaning, ${advice}`]);
    expect(embedderInstallAdvice(deps)).toBe(advice);
  });

  it('on Windows leaves a pnpm store path alone even with no package.json above it', () => {
    const { calls, deps } = machine({
      platform: 'win32',
      packageRoot: at('/work/app/node_modules/.pnpm/hippo-memory@1.0.0/node_modules/hippo-memory'),
      files: [path.join(at('/work/app/node_modules'), NPM_CLI), '/work/app/pnpm-lock.yaml'],
    });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(calls).toEqual([]);
    expect(embedderInstallAdvice(deps)).toBe(`run \`pnpm add ${PKG}\` in ${at('/work/app')}`);
  });

  it("names npm's exit code when the install fails, and does not throw", () => {
    const { deps } = machine({ fail: npmExit(243) });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(said().at(-1)).toBe(
      `npm stopped with exit code 243; its error is above. For recall by meaning, ${GLOBAL_ADVICE}`,
    );
  });

  it('says hippo stopped npm when the install runs past its time limit', () => {
    const timedOut = Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT', status: null });
    const { deps } = machine({ fail: timedOut });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(said().at(-1)).toBe(`npm ran for 10 minutes, so hippo stopped it. For recall by meaning, ${GLOBAL_ADVICE}`);
  });

  it('says so when npm finished but the package still does not resolve', () => {
    const { deps } = machine({ installedAfter: false });
    expect(installLocalEmbedder(local, deps)).toBe(false);
    expect(said().at(-1)).toBe(
      `npm finished, but hippo cannot find the package. For recall by meaning, ${GLOBAL_ADVICE}`,
    );
  });
});
