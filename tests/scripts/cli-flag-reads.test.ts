import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectVerbReads } from '../../scripts/cli-flag-reads.mjs';

// The real ES2022 lib is slow to parse on a shared runner, and the walker needs no global types.
const MINIMAL_LIB = [
  'interface Array<T> { length: number; [n: number]: T }',
  'interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {}',
  'interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}',
  'interface Promise<T> {}',
].join('\n');

const TSCONFIG = {
  compilerOptions: { noLib: true, noEmit: true, module: 'ES2022', moduleResolution: 'Bundler', types: [] },
  include: ['lib.d.ts', 'src/**/*'],
};

const ROWS = `declare function verb(load: () => unknown, name: string): unknown;
export const ROWS = {
  plain: verb(() => import('../kinds.js'), 'handlePlain'),
  config: verb(() => import('../kinds.js'), 'handleConfig'),
  computed: verb(() => import('../kinds.js'), 'handleComputed'),
};
`;

// One factory, three kind configs: what the walker finds per row is what case 14e compares to each row's declaration.
const KINDS = `type Flags = Record<string, string | boolean | undefined>;
interface Kind {
  readonly body: (flags: Flags) => string | undefined;
  readonly filterFlag?: string;
  readonly extra?: { readonly sub: string; readonly run: (flags: Flags) => void };
}
function text(flags: Flags, name: string): string | undefined {
  const raw = flags[name];
  return typeof raw === 'string' ? raw : undefined;
}
function pick(): string {
  return 'owner';
}
function kindVerbs(kind: Kind): (cc: { args: string[]; flags: Flags }) => void {
  return ({ args, flags }) => {
    if (args[0] === kind.extra?.sub) return kind.extra.run(flags);
    const filter = kind.filterFlag === undefined ? undefined : text(flags, kind.filterFlag);
    const body = kind.body(flags);
    args.push(filter ?? '', body ?? '');
  };
}
const plainKind: Kind = { body: (flags) => text(flags, 'text') };
const configKind: Kind = {
  body: (flags) => text(flags, 'summary'),
  filterFlag: 'repo',
  extra: { sub: 'refresh', run: (flags) => void text(flags, 'since') },
};
const computedKind: Kind = { body: (flags) => text(flags, 'text'), filterFlag: pick() };
export const handlePlain = kindVerbs(plainKind);
export const handleConfig = kindVerbs(configKind);
export const handleComputed = kindVerbs(computedKind);
`;

describe('cli-flag-reads', { timeout: 30_000 }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-flag-reads-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('follows a kind config passed to a row factory, so each row reads only its own kind body, filter and extra', () => {
    file('tsconfig.json', JSON.stringify(TSCONFIG));
    file('lib.d.ts', MINIMAL_LIB);
    file('src/surface/cli/verbs/rows.ts', ROWS);
    file('src/surface/cli/kinds.ts', KINDS);
    const found = collectVerbReads(dir);
    // A flag declared on plain but read only by config is dead there; repo left off config is a missing read.
    expect(found.verbs).toEqual([
      { verb: 'plain', flags: { text: 'value' } },
      { verb: 'config', flags: { repo: 'value', since: 'value', summary: 'value' } },
      { verb: 'computed', flags: { text: 'value' } },
    ]);
    // A config member that is no literal is reported, never dropped.
    expect(found.unfollowed).toEqual([expect.stringMatching(/^src\/surface\/cli\/kinds\.ts:\d+ +computed key: /)]);
  });
});
