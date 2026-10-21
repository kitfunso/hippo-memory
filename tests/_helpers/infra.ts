// The real outside services for a test Context, as a composition root sets them: one reranker registry per test file.
import { rootInfra } from '../../src/infra/ports.js';

export const testInfra = rootInfra();
