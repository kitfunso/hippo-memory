// An embedding run with production switches at HIPPO_FAKE_NOW or the wall clock, for tests that call a domain function.
import type { EmbedRun } from '../../src/domain/search/embed-memories.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { FailureNotices } from '../../src/base/util/failure-notices.js';
import { DetachedSet } from '../../src/base/util/detached-set.js';

export const TEST_RUN: EmbedRun = { clock: evalNow, failureNotices: new FailureNotices() };

/** Takes the embeds a domain call detaches, as a root's runtime does. Nothing settles it, so it
 * serves only a test that reads no vector. */
export const TEST_DETACHED = new DetachedSet();
