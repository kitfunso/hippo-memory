// What the local remember pipeline of `hippo remember` and `hippo watch` stores, counts, embeds and prints with no
// server: each salience verdict, extraction with no key and the embedding kick-off. The flag cases live in
// cli-write-verbs. The first case of each verb spawns the built CLI; the rest run it in process.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATH_TAGS, remembered, Store, type ParsedRow, type Ran } from '../_helpers/cli-verb-store.js';
import { startHashedEmbeddings, type HashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { loadEmbeddingIndex } from '../_helpers/root-forms.js';

const TEXT = 'the billing service retries a failed charge three times';
const STDERR = 'connection refused on port 5432\n';
const LEARNED: Ran = {
  status: 3,
  stdout: '',
  stderr: `${STDERR}\nHippo learned from failure: "connection refused on port 5432"\n`,
};
const NO_KEY = '  (extraction skipped: ANTHROPIC_API_KEY not set)\n';

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

/** A command that fails the same way in every shell. */
function failingScript(s: Store): void {
  writeFileSync(join(s.cwd, 'fail.js'), `process.stderr.write(${JSON.stringify(STDERR)}); process.exit(3);\n`);
}

const skipped = (verdict: string): Ran => ({ status: 0, stdout: `Skipped (salience: ${verdict})\n`, stderr: '' });
const ids = (rows: readonly ParsedRow[]): string[] => rows.map((r) => String(r['id']));

describe('hippo remember with the salience gate on (built CLI, no server)', () => {
  it('skips a repeat of the same text without counting it, and --force and --pin each store it', async () => {
    const s = new Store({ spawned: true });
    configure(s.root, { salience: { enabled: true } });
    const runs = [
      await s.run('remember', TEXT),
      await s.run('remember', TEXT),
      await s.run('remember', TEXT, '--force'),
      await s.run('remember', TEXT, '--pin'),
    ];
    const rows = s.rows();
    // A forced or pinned repeat is stored at half the half-life of the first.
    expect(rows.map((r) => [r['content'], r['half_life_days'], r['pinned']])).toEqual([
      [TEXT, 365, 0],
      [TEXT, 182.5, 0],
      [TEXT, 182.5, 1],
    ]);
    const [first, forced, pinned] = rows;
    expect(runs).toEqual([
      remembered(first!),
      skipped(`duplicate (same text as ${String(first!['id'])}), score 0.10`),
      remembered(forced!),
      remembered(pinned!),
    ]);
    expect(s.audit()).toEqual(ids(rows).map((id) => `default cli remember ${id}`));
    expect(s.counters()['total_remembered']).toBe('3');
  });

  it('skips a text under the minimum length', async () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    expect(await s.run('remember', 'abcd')).toEqual(skipped('content_too_short, score 0.00'));
    expect([s.rows(), s.audit(), s.counters()['total_remembered']]).toEqual([[], [], '0']);
  });

  it('stores a near-duplicate whose value changed, at full strength', async () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    const runs = [
      await s.run('remember', TEXT),
      await s.run('remember', 'the billing service retries a failed charge five times'),
    ];
    const rows = s.rows();
    expect(rows.map((r) => [r['content'], r['strength'], r['half_life_days']])).toEqual([
      [TEXT, 1, 365],
      ['the billing service retries a failed charge five times', 1, 182.5],
    ]);
    expect(runs).toEqual(rows.map((r) => remembered(r)));
    expect(s.counters()['total_remembered']).toBe('2');
  });

  it('starts a repeated error weak, with half the half-life, and counts it', async () => {
    const s = new Store();
    configure(s.root, { salience: { enabled: true } });
    const seeded: string[] = [];
    for (let n = 1; n <= 4; n++) seeded.push(s.seed(`connection timeout on database shard ${n}`, { tags: ['error'] }));
    s.settle();
    const ran = await s.run('remember', 'connection timeout on database shard 5', '--error');
    const rows = s.rows();
    expect(rows.slice(0, 4).map((r) => [r['strength'], r['half_life_days']])).toEqual(Array(4).fill([1, 730]));
    const added = rows[4]!;
    expect(added).toMatchObject({
      content: 'connection timeout on database shard 5',
      strength: 0.3,
      half_life_days: 547.5,
      tags: ['error', ...PATH_TAGS],
      emotional_valence: 'negative',
    });
    const weakened = `Weakened (salience: repeat_error (4 recent errors, overlap 100% with ${seeded[0]}), strength 0.30)\n`;
    expect(ran).toEqual({ ...remembered(added), stdout: weakened + remembered(added).stdout });
    expect(s.audit()).toEqual([`default cli remember ${String(added['id'])}`]);
    expect(s.counters()['total_remembered']).toBe('1');
  });

  it('the gate of the global store judges a --global write', async () => {
    const s = new Store({ global: true });
    configure(s.home, { salience: { enabled: true } });
    const first = await s.run('remember', TEXT, '--global');
    const second = await s.run('remember', TEXT, '--global');
    const [row, ...rest] = s.rows('global');
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ content: TEXT, source: 'cli-global', origin_project: '' });
    expect([first, second]).toEqual([
      remembered(row!, '[global] '),
      skipped(`duplicate (same text as ${String(row!['id'])}), score 0.10`),
    ]);
    expect([s.counters()['total_remembered'], s.counters('global')['total_remembered']]).toEqual(['0', '1']);
  });
});

describe('hippo remember extraction with no key (built CLI, no server)', () => {
  /** A store with no Anthropic key, so extraction says why it did not run. */
  function keyless(opts: { spawned?: boolean } = {}): Store {
    const s = new Store(opts);
    s.env['ANTHROPIC_API_KEY'] = '';
    return s;
  }

  it('--extract says the key is missing and the row is still stored', async () => {
    const s = keyless({ spawned: true });
    const ran = await s.run('remember', TEXT, '--extract');
    const rows = s.rows();
    expect(rows).toHaveLength(1);
    expect(ran).toEqual({ ...remembered(rows[0]!), stderr: NO_KEY });
    expect(s.counters()['total_remembered']).toBe('1');
  });

  it('extraction enabled in the config says the same without the flag', async () => {
    const s = keyless();
    configure(s.root, { extraction: { enabled: true } });
    const ran = await s.run('remember', TEXT);
    const rows = s.rows();
    expect(rows).toHaveLength(1);
    expect(ran).toEqual({ ...remembered(rows[0]!), stderr: NO_KEY });
  });

  it('a write the gate skips is not offered for extraction', async () => {
    const s = keyless();
    configure(s.root, { salience: { enabled: true } });
    const first = await s.run('remember', TEXT, '--extract');
    const second = await s.run('remember', TEXT, '--extract');
    const [row] = s.rows();
    expect(first).toEqual({ ...remembered(row!), stderr: NO_KEY });
    expect(second).toEqual(skipped(`duplicate (same text as ${String(row!['id'])}), score 0.10`));
    expect(s.counters()['total_remembered']).toBe('1');
  });
});

describe('hippo watch never gates or extracts (built CLI, no server)', () => {
  it('stores and counts a repeated failure twice with salience and extraction both on', async () => {
    const s = new Store({ spawned: true });
    s.env['ANTHROPIC_API_KEY'] = '';
    configure(s.root, { salience: { enabled: true }, extraction: { enabled: true } });
    failingScript(s);
    expect([await s.run('watch', 'node', 'fail.js'), await s.run('watch', 'node', 'fail.js')]).toEqual([
      LEARNED,
      LEARNED,
    ]);
    const rows = s.rows();
    expect(rows.map((r) => [r['source'], r['strength']])).toEqual([
      ['autolearn', 1],
      ['autolearn', 1],
    ]);
    expect(s.audit()).toEqual(ids(rows).map((id) => `default cli remember ${id}`));
    expect(s.counters()['total_remembered']).toBe('2');
  });
});

describe('embedding after a local write (built CLI, local embeddings server)', () => {
  let embeddings: HashedEmbeddings;
  beforeAll(async () => {
    embeddings = await startHashedEmbeddings();
  });
  afterAll(async () => {
    await embeddings.close();
  });

  // Spawned: watch exits before its embedding lands, which only a process that ends can show.
  it('remember leaves a vector for its row; watch exits before its own lands', async () => {
    const s = new Store({ spawned: true });
    s.env['OPENAI_API_KEY'] = 'test-key-not-secret';
    configure(s.root, { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } });
    failingScript(s);
    const first = await s.run('remember', TEXT);
    expect(await s.run('watch', 'node', 'fail.js')).toEqual(LEARNED);
    const rows = s.rows();
    expect(first).toEqual(remembered(rows[0]!));
    expect(rows.map((r) => r['source'])).toEqual(['cli', 'autolearn']);
    expect(Object.keys(loadEmbeddingIndex(s.root))).toEqual([String(rows[0]!['id'])]);
    expect(s.counters()['total_remembered']).toBe('2');
  });
});
