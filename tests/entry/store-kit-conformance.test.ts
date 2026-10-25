// The conformance suite hippo-memory/store-kit ships passes on hippo.db's store and on the smallest store.
import { runPackagedConformance } from '../_helpers/store-conformance.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

runPackagedConformance();
