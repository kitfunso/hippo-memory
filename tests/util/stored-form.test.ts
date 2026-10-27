// The stored form of a text is its strict redaction: it is stable on a second pass, and every helper the sinks use agrees with it.
import { describe, it, expect } from 'vitest';
import {
  detectSecret,
  onlyRedacted,
  redactEntry,
  redactSecretsStrict,
  textForms,
} from '../../src/base/util/secret-detect.js';
import { contentDigests, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { ASSIGNED_SECRET_LINES, ORDINARY_CONFIG_LINES, runtimeJoin } from '../_helpers/secret-shapes.js';

const GHP = runtimeJoin('ghp_', 'x1Y2z3W4v5'.repeat(3), 'Q6r7S8');
const JWT = runtimeJoin('eyJ', 'hbGciOiJIUzI1', '.eyJ', 'zdWIiOiIxMjM0', '.sig', 'nature_part');
const SHAPES = [...ASSIGNED_SECRET_LINES, `token ${GHP}`, `Authorization: Bearer ${JWT}`, JWT];

describe('the stored form', () => {
  it('is the same after a second pass over every secret shape', () => {
    for (const text of SHAPES) {
      const once = redactSecretsStrict(text);
      expect(once, text).not.toBe(text);
      expect(redactSecretsStrict(once), text).toBe(once);
    }
  });

  it('answers the same on repeat calls, so the shared global patterns keep no state', () => {
    for (const text of [...SHAPES, ...ORDINARY_CONFIG_LINES]) {
      expect(redactSecretsStrict(text)).toBe(redactSecretsStrict(text));
      expect(detectSecret({ content: text, tags: [] })).toEqual(detectSecret({ content: text, tags: [] }));
    }
  });

  it('keeps empty text as given', () => {
    expect(redactSecretsStrict('')).toBe('');
  });
});

describe('redactEntry', () => {
  it('returns the same object when nothing is secret', () => {
    const entry = { id: 'a', content: 'the nightly job runs at two', source: 'cli' };
    expect(redactEntry(entry)).toBe(entry);
  });

  it('redacts content and source in a copy', () => {
    const entry = { id: 'a', content: `ci token ${GHP}`, source: `import:${GHP}` };
    const stored = redactEntry(entry);
    expect(stored).not.toBe(entry);
    expect(stored).toEqual({ id: 'a', content: 'ci token [REDACTED]', source: 'import:[REDACTED]' });
    expect(entry.content).toContain(GHP);
  });

  it('adds no source key to an entry without one', () => {
    expect(Object.keys(redactEntry({ content: `ci token ${GHP}` }))).toEqual(['content']);
  });
});

describe('textForms and contentDigests', () => {
  it('names one form for clean text and the stored form first for secret text', () => {
    expect(textForms('plain words')).toEqual(['plain words']);
    expect(textForms(`ci token ${GHP}`)).toEqual(['ci token [REDACTED]', `ci token ${GHP}`]);
  });

  it('digests each form', () => {
    const text = `ci token ${GHP}`;
    expect(contentDigests(text)).toEqual([rejectionDigest('ci token [REDACTED]'), rejectionDigest(text)]);
  });
});

describe('onlyRedacted', () => {
  it('is true only for markers and whitespace', () => {
    expect(onlyRedacted(redactSecretsStrict(GHP))).toBe(true);
    expect(onlyRedacted(` [REDACTED]\n[REDACTED] `)).toBe(true);
    expect(onlyRedacted('deploy key is [REDACTED]')).toBe(false);
    expect(onlyRedacted('')).toBe(false);
    expect(onlyRedacted('   ')).toBe(false);
  });
});
