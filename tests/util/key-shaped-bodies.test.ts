// An open-body pattern counts a match only when its body holds a digit or a capital: names in lowercase words stay,
// made-up keys still redact, and a long run of prefixes is scanned once.
import { describe, expect, it } from 'vitest';
import { detectSecret, redactSecretsStrict, storedSource } from '../../src/base/util/secret-detect.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import { storedProjectName } from '../../src/base/scope/project-identity.js';
import { extractPathTags } from '../../src/domain/search/path-context.js';

const WORD_NAMES = [
  runtimeJoin('sk-', 'hynix-memory-analysis'),
  runtimeJoin('gl', 'pat-', 'deployment-configuration'),
  runtimeJoin('xo', 'xb-', 'team-notes-folder'),
  runtimeJoin('ya29', '.', 'release-notes-for-the-team'),
  'convert_sk_model_to_onnx',
  'use_sk_learn_pipeline',
  runtimeJoin('my_sk', '-learn-tutorial-notebooks'),
  runtimeJoin('sk_', 'vendor_release_notes'),
];

const KEYS = [
  runtimeJoin('sk-', 'proj', 'Ab3dEf6gHi9jKl2mNo5p'),
  runtimeJoin('sk-', 'ABCDEFGHIJKLMNOPQRSTUVWX'),
  runtimeJoin('gl', 'pat-', 'xY7zQ2wE9rT4yU1iO6pA'),
  runtimeJoin('xo', 'xb-', '1234567890-abcdefGHIJ'),
  runtimeJoin('ya29', '.', 'a0AfH6SMBx7Qd2kLm9NpQrStUv'),
  runtimeJoin('sk_', 'vendor_', 'Q8w2E7r4T1y9'),
];

describe('key-shaped bodies', () => {
  it.each(WORD_NAMES)('keeps the word name %s as it is', (name) => {
    expect(redactSecretsStrict(`notes in ${name}/src`)).toBe(`notes in ${name}/src`);
    expect(storedSource(`${name}/MEMORY.md#deploy`)).toBe(`${name}/MEMORY.md#deploy`);
    expect(detectSecret({ content: `the api key folder ${name}`, tags: [] }).flagged).toBe(false);
  });

  it.each(KEYS)('still redacts the made-up key %s', (key) => {
    expect(redactSecretsStrict(`use ${key} now`)).toBe('use [REDACTED] now');
    expect(storedSource(`${key}/MEMORY.md`)).toMatch(/^\[REDACTED~[0-9a-f]{12}\]\/MEMORY\.md$/);
  });

  it.each(['_sk-', '_sk_', 'sk-'])('scans 200,000 characters of %s runs in under 200 ms', (run) => {
    const text = run.repeat(Math.ceil(200_000 / run.length));
    const started = performance.now();
    redactSecretsStrict(text);
    storedSource(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('derived names scan the original case', () => {
  const aws = runtimeJoin('AKIA', 'Q7'.repeat(8));

  it('storedProjectName keeps no lowercased key', () => {
    const stored = storedProjectName(`repo-${aws}`);
    expect(stored).toBe(stored.toLowerCase());
    expect(stored).not.toContain(aws.toLowerCase());
  });

  it('extractPathTags drops a segment that holds a key before lowercasing it', () => {
    expect(extractPathTags(`/work/${aws}/src`)).toEqual(['path:work', 'path:src']);
  });
});
