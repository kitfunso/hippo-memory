import { test } from 'vitest';
import './does-not-exist.mjs';

test('prepublish gate fixture: never collected', () => {});
