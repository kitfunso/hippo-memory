import { beforeEach } from 'vitest';
import { makeRoot } from './make-root.js';

export let root: string;

export function useCardsRoot({ init = true }: { init?: boolean } = {}) {
  beforeEach(() => {
    root = makeRoot('w2a-cards', { init });
  });
}
