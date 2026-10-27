// One function makes a stored source: each part a reader splits on stays distinct exactly when it was, and no raw part survives.
import { describe, expect, it } from 'vitest';
import { redactSecretsStrict, sourceForms, storedSource } from '../../src/base/util/secret-detect.js';
import { itemSource, splitSource, storedItemKey } from '../../src/domain/agent-memories/source.js';
import { planContainer } from '../../src/domain/agent-memories/plan.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

const GH = runtimeJoin('ghp_', 'Ab3'.repeat(12));
const AWS = runtimeJoin('AKIA', 'Q7'.repeat(8));
const B64 = runtimeJoin('token=', 'abc/def123456789xyz');
const GL = runtimeJoin('gl', 'pat');
const PREFIX = 'agent-memory:claude-code:p-0123456789ab/';

const SOURCES = [
  'cli',
  `${PREFIX}deploy-${GH}.md#ff00`,
  `${PREFIX}MEMORY.md/${GL}-deployment-configuration/aaaaaaaaaaaa#11`,
  `${PREFIX}note_${GH}.md#aa`,
  `x/${B64}/y.md#cc`,
  `src_${AWS}`,
  runtimeJoin('https://user:', 'pw12345', '@host/p#1'),
  `claude-memory:k-${GH}.md`,
];
const RAW_PARTS = [GH, AWS, 'abc/def123', 'pw12345'];

describe('storedSource', () => {
  it.each(SOURCES)('%s is stable on a second pass, under the strict redaction, and holds no raw part', (source) => {
    const stored = storedSource(source);
    expect(storedSource(stored)).toBe(stored);
    expect(redactSecretsStrict(stored)).toBe(stored);
    for (const raw of RAW_PARTS) expect(stored).not.toContain(raw);
    expect(sourceForms(source)).toEqual(stored === source ? [source] : [stored, source]);
  });

  it('keeps two parts that redact alike apart, and the parts around them as they were', () => {
    const one = storedSource(`${PREFIX}MEMORY.md/${GL}-deployment-configuration/aaaaaaaaaaaa#11`);
    const two = storedSource(`${PREFIX}MEMORY.md/${GL}-staging-authentication/aaaaaaaaaaaa#11`);
    expect(one).not.toBe(two);
    expect(one.split('/')).toHaveLength(4);
    expect(one.startsWith(`${PREFIX}MEMORY.md/[REDACTED~`)).toBe(true);
    expect(one.endsWith('/aaaaaaaaaaaa#11')).toBe(true);
  });

  it('keeps a secret that spans a separator in one part, with the separator', () => {
    const stored = storedSource(`x/${B64}/y.md#cc`);
    expect(stored).toMatch(/^x\/\[REDACTED~[0-9a-f]{12}\]\.md#cc$/);
  });

  it('round-trips a key whose file name and heading both hold a token, so a second sync finds it unchanged', () => {
    const key = `notes-${GH}.md/${GL}-deployment-configuration/aaaaaaaaaaaa`;
    const source = itemSource(PREFIX, { key, text: 'Run the schema check before every deploy.' });
    const split = splitSource(source, PREFIX);
    expect(split.key).toBe(storedItemKey(key));
    expect(splitSource(source.replace(/notes-\[REDACTED~[0-9a-f]{12}\][^/#]*/, `notes-${GH}.md`), PREFIX).key).toBe(
      split.key,
    );
    const plan = planContainer({
      textKeyed: true,
      items: [{ key, hash: split.hash, refused: false }],
      skipped: [],
      live: [{ id: 'r1', key: split.key, hash: split.hash, tagged: true, created: '2026-09-01T00:00:00.000Z' }],
      dormant: [],
      legacy: undefined,
      isDuplicate: () => false,
    });
    expect(plan).toMatchObject({ unchanged: 1, writes: [], setAside: [] });
  });
});

describe('a token glued on by an underscore', () => {
  it('is redacted in text', () => {
    expect(redactSecretsStrict(`note_${GH}.md and x_${AWS}`)).toBe('note_[REDACTED].md and x_[REDACTED]');
  });

  it('is stored with no raw part in content and source', () => {
    const root = makeRoot('stored-source-underscore');
    const entry = { ...createMemory(`deploy note_${GH} before the release`), source: `src_${AWS}` };
    writeEntry(root, entry);
    const db = openHippoDb(root);
    try {
      // SAFETY: the SELECT projects n only.
      const row = db
        .prepare('SELECT count(*) AS n FROM memories WHERE instr(content, ?) > 0 OR instr(source, ?) > 0')
        .get(GH, AWS) as { n: number };
      expect(row.n).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

const PEM_SOURCE = runtimeJoin(
  'import:-----BEGIN ',
  'PRIVATE KEY-----\nfirstBODY1/secondBODY2/lastBODY3\n-----END ',
  'PRIVATE KEY-----',
);
const SLASHED = runtimeJoin('import:token=', 'abc123XYZ'.repeat(3), '/', 'def456LMN'.repeat(3));

describe('storedSource from whole-source spans', () => {
  it.each([
    ['a PEM block with a slash in its body', PEM_SOURCE, ['secondBODY2', 'lastBODY3', 'firstBODY1']],
    ['a slash-bearing credential whose first segment matches', SLASHED, ['def456LMN', 'abc123XYZ']],
  ])('%s leaves no raw byte of the span', (_name, source, raws) => {
    const stored = storedSource(source);
    for (const raw of raws) expect(stored).not.toContain(raw);
    expect(stored.startsWith('import:')).toBe(true);
  });

  it.each(['x/token=abc/def123456789 bearer xyz#h', 'https://u:pw12345@host bearer ab/p#1'])(
    '%s reaches a fixed point',
    (source) => {
      const stored = storedSource(source);
      expect(storedSource(stored)).toBe(stored);
      expect(redactSecretsStrict(stored)).toBe(stored);
    },
  );

  it.each(['convert_sk_model_to_onnx', 'use_sk_learn_pipeline', 'my_sk-learn-tutorial-notebooks'])(
    'keeps the snake-case name %s as it is',
    (text) => {
      expect(redactSecretsStrict(text)).toBe(text);
      expect(storedSource(`notes/${text}.md`)).toBe(`notes/${text}.md`);
    },
  );

  it('never pairs two keys on a heading a secret span emptied', () => {
    const gone = runtimeJoin('token=abc/def', '123456789xyz/aaaa');
    const fresh = runtimeJoin('password=qqq/rrr', '987654321abc/bbbb');
    const plan = planContainer({
      textKeyed: true,
      items: [{ key: fresh, hash: 'h2', refused: false }],
      skipped: [],
      live: [{ id: 'r1', key: storedItemKey(gone), hash: 'h1', tagged: true, created: '2026-09-01T00:00:00.000Z' }],
      dormant: [],
      legacy: undefined,
      isDuplicate: () => false,
    });
    expect(plan.setAside).toEqual(['r1']);
    expect(plan.writes.flatMap((w) => w.supersedes)).toEqual([]);
  });
});
