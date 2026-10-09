// Pins what the local remember pipeline of `hippo remember` and `hippo watch` stores, counts, embeds and prints on the built CLI with no
// server: the `remembered` counter, each salience verdict, a refused --kind, extraction with no key and the embedding kick-off.
// What a snapshot masks is listed in tests/_helpers/cli-parity-store.ts.
import { afterAll, beforeAll, describe, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminActor, reject } from '../src/api/index.js';
import { loadEmbeddingIndex } from '../src/store/vector-index.js';
import { query, Store, type ExtraState } from './_helpers/cli-parity-store.js';
import { startHashedEmbeddings, type HashedEmbeddings } from './_helpers/hashed-embedding-server.js';

const CASE_MS = 180_000;
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
  it.each(REMEMBER_FLAGS)('%s', (_label, flags) => {
    const s = new Store();
    s.run('remember', TEXT, ...flags);
    s.expectPinned(globalCounter(s));
  }, CASE_MS);

  it('two rows count two', () => {
    const s = new Store();
    s.run('remember', TEXT, '--tag', 'billing');
    s.run('remember', 'the invoice worker sends a receipt after each charge', '--tag', 'billing');
    s.expectPinned();
  }, CASE_MS);

  it('a --kind outside the two allowed stores nothing and counts nothing', () => {
    const s = new Store();
    s.run('remember', TEXT, '--kind', 'raw');
    s.run('remember', TEXT, '--kind', 'nonsense');
    s.expectPinned();
  }, CASE_MS);

  it('a rejected value is refused and not counted', () => {
    const s = new Store();
    reject({ hippoRoot: s.root, tenantId: 'default', actor: adminActor('cli') }, { value: REJECTED, reason: 'wrong' });
    s.settle();
    s.run('remember', REJECTED);
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo remember with the salience gate on (built CLI, no server)', () => {
  it('skips a repeat of the same text without counting it, and --force and --pin each store it', () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    s.run('remember', TEXT);
    s.run('remember', TEXT);
    s.run('remember', TEXT, '--force');
    s.run('remember', TEXT, '--pin');
    s.expectPinned();
  }, CASE_MS);

  it('skips a text under the minimum length', () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    s.run('remember', 'abcd');
    s.expectPinned();
  }, CASE_MS);

  it('stores a near-duplicate whose value changed, at full strength', () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    s.run('remember', TEXT);
    s.run('remember', 'the billing service retries a failed charge five times');
    s.expectPinned();
  }, CASE_MS);

  it('starts a repeated error weak, with half the half-life, and counts it', () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    for (let n = 1; n <= 4; n++) s.seed(`connection timeout on database shard ${n}`, { tags: ['error'] });
    s.settle();
    s.run('remember', 'connection timeout on database shard 5', '--error');
    s.expectPinned();
  }, CASE_MS);

  it('the gate of the global store judges a --global write', () => {
    const s = new Store({ global: true });
    configure(s.home, { salience: { enabled: true } });
    s.run('remember', TEXT, '--global');
    s.run('remember', TEXT, '--global');
    s.expectPinned(globalCounter(s));
  }, CASE_MS);
});

describe('hippo remember extraction with no key (built CLI, no server)', () => {
  it('--extract says the key is missing and the row is still stored', () => {
    const s = new Store();
    s.env['ANTHROPIC_API_KEY'] = '';
    s.run('remember', TEXT, '--extract');
    s.expectPinned();
  }, CASE_MS);

  it('extraction enabled in the config says the same without the flag', () => {
    const s = new Store();
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { extraction: { enabled: true } });
    s.run('remember', TEXT);
    s.expectPinned();
  }, CASE_MS);

  it('a write the gate skips is not offered for extraction', () => {
    const s = new Store();
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { salience: { enabled: true } });
    s.run('remember', TEXT, '--extract');
    s.run('remember', TEXT, '--extract');
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo watch never gates or extracts (built CLI, no server)', () => {
  it('stores and counts a repeated failure twice with salience and extraction both on', () => {
    const s = new Store();
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { salience: { enabled: true }, extraction: { enabled: true } });
    failingScript(s);
    s.run('watch', 'node fail.js');
    s.run('watch', 'node fail.js');
    s.expectPinned();
  }, CASE_MS);
});

describe('embedding after a local write (built CLI, local embeddings server)', () => {
  let embeddings: HashedEmbeddings;
  beforeAll(async () => { embeddings = await startHashedEmbeddings(); });
  afterAll(async () => { await embeddings.close(); });

  it('remember leaves a vector for its row; watch exits before its own lands', async () => {
    const s = new Store();
    s.env['OPENAI_API_KEY'] = 'test-key-not-secret';
    configure(s.root, { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } });
    failingScript(s);
    await s.runAsync('remember', TEXT);
    await s.runAsync('watch', 'node fail.js');
    s.expectPinned({ rows: query(s.root, 'SELECT id FROM memories ORDER BY rowid'), vectors: Object.keys(loadEmbeddingIndex(s.root)) });
  }, CASE_MS);
});
