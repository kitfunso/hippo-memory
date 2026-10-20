// vitest runner: releases the stores tests/_helpers/held-stores.ts holds once a test's body ends, before its afterEach
// hooks run, since those remove the test's folders and no public hook runs between the two.
import { TestRunner } from 'vitest';
import { releaseHeldStores } from './_helpers/held-stores.js';

export default class HeldStoresRunner extends TestRunner {
  onTaskFinished(): void {
    releaseHeldStores();
  }
}
