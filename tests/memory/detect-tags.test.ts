import { describe, expect, it } from 'vitest';
import {
  DETECT_TAG_PREFIX,
  detectorOf,
  detectorTags,
  isDetectTag,
  withoutDetectTags,
  type Detector,
} from '../../src/base/memory/detect-tags.js';

const DETECTOR: Detector = {
  applies: ['**/*.py', 'src/**/*.ts'],
  commands: [['pytest'], ['ruff check', 'flake8']],
};

describe('the detect: tag codec', () => {
  it('writes one tag per glob and one per command group, and reads the same detector back', () => {
    const tags = detectorTags(DETECTOR);
    expect(tags).toEqual([
      'detect:applies:**/*.py',
      'detect:applies:src/**/*.ts',
      'detect:cmd:["pytest"]',
      'detect:cmd:["ruff check","flake8"]',
    ]);
    expect(detectorOf(tags)).toEqual(DETECTOR);
  });

  it('reads a detector out of a tag list that also holds other tags', () => {
    const tags = ['rule', 'from-user', ...detectorTags(DETECTOR), 'path:hippo'];
    expect(detectorOf(tags)).toEqual(DETECTOR);
  });

  it('keeps a detector with no applies glob, which applies to any edit', () => {
    const anyEdit: Detector = { applies: [], commands: [['pytest']] };
    expect(detectorOf(detectorTags(anyEdit))).toEqual(anyEdit);
  });

  it('drops a command group that is not a JSON array and keeps the good ones', () => {
    const tags = ['detect:cmd:not json', 'detect:cmd:{"a":1}', 'detect:cmd:"pytest"', 'detect:cmd:["pytest"]'];
    expect(detectorOf(tags)).toEqual({ applies: [], commands: [['pytest']] });
  });

  it('drops empty and non-string commands from a group, and a group left with none', () => {
    const tags = ['detect:cmd:[]', 'detect:cmd:["", "  "]', 'detect:cmd:[1,null]', 'detect:cmd:[1,"pytest"]'];
    expect(detectorOf(tags)).toEqual({ applies: [], commands: [['pytest']] });
  });

  it('drops an applies tag with an empty glob', () => {
    const tags = ['detect:applies:', 'detect:applies:**/*.py', 'detect:cmd:["pytest"]'];
    expect(detectorOf(tags)).toEqual({ applies: ['**/*.py'], commands: [['pytest']] });
  });

  it('writes no tags for a detector with no command group, even when it has globs', () => {
    expect(detectorTags({ applies: ['**/*.py'], commands: [] })).toEqual([]);
    expect(detectorTags({ applies: ['**/*.py'], commands: [[]] })).toEqual([]);
    expect(detectorTags({ applies: [], commands: [] })).toEqual([]);
  });

  it('reads no detector from tags with no usable command group', () => {
    expect(detectorOf([])).toBeNull();
    expect(detectorOf(['rule', 'from-user'])).toBeNull();
    expect(detectorOf(['detect:applies:**/*.py'])).toBeNull();
    expect(detectorOf(['detect:cmd:not json', 'detect:cmd:[]'])).toBeNull();
  });
});

describe('telling detect: tags from the rest', () => {
  it('matches the prefix at the start of a tag only', () => {
    expect(DETECT_TAG_PREFIX).toBe('detect:');
    expect(isDetectTag('detect:cmd:["pytest"]')).toBe(true);
    expect(isDetectTag('detect:')).toBe(true);
    expect(isDetectTag('detect')).toBe(false);
    expect(isDetectTag('Detect:cmd')).toBe(false);
    expect(isDetectTag('path:detect:x')).toBe(false);
  });

  it('removes every detect: tag and keeps the others in order', () => {
    const tags = ['b', ...detectorTags(DETECTOR), 'a', 'from-user'];
    expect(withoutDetectTags(tags)).toEqual(['b', 'a', 'from-user']);
    expect(withoutDetectTags(['a'])).toEqual(['a']);
    expect(withoutDetectTags([])).toEqual([]);
  });
});
