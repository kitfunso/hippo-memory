// Pins what the local remember pipeline of `hippo remember` and `hippo watch` stores, counts, embeds and prints on the built CLI with no
// server: the `remembered` counter, each salience verdict, a refused --kind, extraction with no key and the embedding kick-off.
// What a snapshot masks is listed in tests/_helpers/cli-parity-store.ts. The first case of each verb spawns the built CLI; the rest run it in process.
import { afterAll, beforeAll, describe, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminActor, reject } from '../../src/api/index.js';
import { loadEmbeddingIndex } from '../../src/store/vector-index.js';
import { query, Store, type ExtraState } from '../_helpers/cli-parity-store.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { apiCtx } from '../_helpers/api-ctx.js';

const TEXT = 'the billing service retries a failed charge three times';
const REJECTED = 'the billing service retries a failed charge nine times';
const STDERR = 'connection refused on port 5432\n';

/** The part of `config.json` a case sets. */
interface StoreConfig {
  salience?: { enabled: boolean };
  extraction?: { enabled: boolean };
  embeddings?: { provider: string; model: string; apiBaseUrl: string };
}

function configure(root: string, config: StoreConfig): void {
  const file = join(root, 'config.json');
  const held: object = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...held, ...config }));
}

/** The global store's `remembered` counter, which the harness reads for the project store alone. */
function globalCounter(s: Store): ExtraState {
  return { globalCounter: query(s.home, "SELECT key, value FROM meta WHERE key = 'total_remembered'") };
}

/** A command that fails the same way in every shell. */
function failingScript(s: Store): void {
  writeFileSync(join(s.cwd, 'fail.js'), `process.stderr.write(${JSON.stringify(STDERR)}); process.exit(3);\n`);
}

const REMEMBER_FLAGS: ReadonlyArray<[string, string[]]> = [
  ['plain', []],
  ['--pin', ['--pin']],
  ['--observed', ['--observed']],
  ['--inferred', ['--inferred']],
  ['--global', ['--global']],
  ['--kind superseded', ['--kind', 'superseded']],
  ['--tag twice plus --error', ['--tag', 'billing', '--tag', 'retry', '--error']],
];

describe('hippo remember counts each stored row once (built CLI, no server)', () => {
  it.each(REMEMBER_FLAGS)('%s', async (label, flags) => {
    const s = new Store({ spawned: label === 'plain' });
    await s.run('remember', TEXT, ...flags);
    s.expectPinned(globalCounter(s));
  });

  it('two rows count two', async () => {
    const s = new Store();
    await s.run('remember', TEXT, '--tag', 'billing');
    await s.run('remember', 'the invoice worker sends a receipt after each charge', '--tag', 'billing');
    s.expectPinned();
  });

  it('a --kind outside the two allowed stores nothing and counts nothing', async () => {
    const s = new Store();
    await s.run('remember', TEXT, '--kind', 'raw');
    await s.run('remember', TEXT, '--kind', 'nonsense');
    s.expectPinned();
  });

  it('a rejected value is refused and not counted', async () => {
    const s = new Store();
    await reject(apiCtx(s.root, 'default', adminActor('cli')), { value: REJECTED, reason: 'wrong' });
    s.settle();
    await s.run('remember', REJECTED);
    s.expectPinned();
  });
});

describe('hippo remember with the salience gate on (built CLI, no server)', () => {
  it('skips a repeat of the same text without counting it, and --force and --pin each store it', async () => {
    const s = new Store({ spawned: true });
    configure(s.root, { salience: { enabled: true } });
    await s.run('remember', TEXT);
    await s.run('remember', TEXT);
    await s.run('remember', TEXT, '--force');
    await s.run('remember', TEXT, '--pin');
    s.expectPinned();
  });

  it('skips a text under the minimum length', async () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    await s.run('remember', 'abcd');
    s.expectPinned();
  });

  it('stores a near-duplicate whose value changed, at full strength', async () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    await s.run('remember', TEXT);
    await s.run('remember', 'the billing service retries a failed charge five times');
    s.expectPinned();
  });

  it('starts a repeated error weak, with half the half-life, and counts it', async () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    for (let n = 1; n <= 4; n++) s.seed(`connection timeout on database shard ${n}`, { tags: ['error'] });
    s.settle();
    await s.run('remember', 'connection timeout on database shard 5', '--error');
    s.expectPinned();
  });

  it('the gate of the global store judges a --global write', async () => {
    const s = new Store({ global: true });
    configure(s.home, { salience: { enabled: true } });
    await s.run('remember', TEXT, '--global');
    await s.run('remember', TEXT, '--global');
    s.expectPinned(globalCounter(s));
  });
});

describe('hippo remember extraction with no key (built CLI, no server)', () => {
  it('--extract says the key is missing and the row is still stored', async () => {
    const s = new Store({ spawned: true });
    s.env['ANTHROPIC_API_KEY'] = '';
    await s.run('remember', TEXT, '--extract');
    s.expectPinned();
  });

  it('extraction enabled in the config says the same without the flag', async () => {
    const s = new Store();
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { extraction: { enabled: true } });
    await s.run('remember', TEXT);
    s.expectPinned();
  });

  it('a write the gate skips is not offered for extraction', async () => {
    const s = new Store();
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { salience: { enabled: true } });
    await s.run('remember', TEXT, '--extract');
    await s.run('remember', TEXT, '--extract');
    s.expectPinned();
  });
});

describe('hippo watch never gates or extracts (built CLI, no server)', () => {
  it('stores and counts a repeated failure twice with salience and extraction both on', async () => {
    const s = new Store({ spawned: true });
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { salience: { enabled: true }, extraction: { enabled: true } });
    failingScript(s);
    await s.run('watch', 'node', 'fail.js');
    await s.run('watch', 'node', 'fail.js');
    s.expectPinned();
  });
});

describe('embedding after a local write (built CLI, local embeddings server)', () => {
  let embeddings: HashedEmbeddings;
  beforeAll(async () => { embeddings = await startHashedEmbeddings(); });
  afterAll(async () => { await embeddings.close(); });

  // Spawned: watch exits before its embedding lands, which only a process that ends can show.
  it('remember leaves a vector for its row; watch exits before its own lands', async () => {
    const s = new Store({ spawned: true });
    s.env['OPENAI_API_KEY'] = 'test-key-not-secret';
    configure(s.root, { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } });
    failingScript(s);
    await s.run('remember', TEXT);
    await s.run('watch', 'node', 'fail.js');
    s.expectPinned({ rows: query(s.root, 'SELECT id FROM memories ORDER BY rowid'), vectors: Object.keys(loadEmbeddingIndex(s.root)) });
  });
});
