// An embedding run with production switches at HIPPO_FAKE_NOW or the wall clock, for tests that call a domain function.
import type { EmbedRun } from '../../src/domain/search/embed-memories.js';
import { evalNow } from '../../src/infra/eval-switches.js';

export const TEST_RUN: EmbedRun = { clock: evalNow };
