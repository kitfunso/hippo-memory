// A fresh uninitialized store root before each W2a card test.
import { beforeEach } from 'vitest';
import { makeRoot } from '../_helpers/make-root.js';

export let root: string;

export function useCardsRoot() {
  beforeEach(() => {
    root = makeRoot('w2a-cards', { init: false });
  });
}
