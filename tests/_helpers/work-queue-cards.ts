// A store root before each W2a card test; uninitialised only for a test of a fresh store's first open.
import { beforeEach } from 'vitest';
import { makeRoot } from '../_helpers/make-root.js';

export let root: string;

export function useCardsRoot({ init = true }: { init?: boolean } = {}) {
  beforeEach(() => {
    root = makeRoot('w2a-cards', { init });
  });
}
