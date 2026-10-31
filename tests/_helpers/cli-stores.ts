// hippo.db with the CLI's store rules, for tests that call capture, digest and doctor code directly.
import type { CaptureTarget } from '../../src/surface/capture/command.js';
import type { CompactionFolder } from '../../src/surface/capture/compaction-record.js';
import type { CliStore } from '../../src/surface/cli/api-context.js';
import { sqliteDiagnosticsStore, sqliteStore } from '../../src/surface/open-store.js';
import { evalStoreRules } from '../../src/infra/eval-switches.js';
import { envLossAversionRatio } from '../../src/base/util/env.js';
import type { EmbedTarget } from '../../src/domain/search/embed-memories.js';
import { detachedEmbedder } from '../../src/api/embeddings.js';
import { loadConfig } from '../../src/host/config-file.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import type { DoctorStore } from '../../src/surface/cli/doctor.js';
import type { HippoDbRepos } from '../../src/store/sqlite/hippo-db.js';
import { TEST_DETACHED, TEST_RUN } from './test-run.js';

/** hippo.db under `root` with no runtime: a test holds it across its commands and reads its mirrors
 * at once. */
export function storeAt(root: string): CliStore {
  return sqliteStore(root, evalStoreRules(envLossAversionRatio()));
}

export function captureTarget(root: string): CaptureTarget {
  const config = loadConfig(root);
  const store = storeAt(root);
  return {
    root,
    store,
    config,
    embed: detachedEmbedder({ store, config, embedderFor: resolveEmbeddingProvider }, TEST_RUN, TEST_DETACHED),
  };
}

export function diagnosticsBodies(root: string): DoctorStore {
  return sqliteDiagnosticsStore(root);
}

/** hippo.db's ledger under `root`, with the folder facts its delivery rows name. */
export function ledgerAt(root: string): Pick<HippoDbRepos, 'ledger' | 'folderFiles'> {
  const { ledger, folderFiles } = storeAt(root).hippoDb;
  return { ledger, folderFiles };
}

/** hippo.db under `root` and the tenant a compaction hook writes as. */
export function compactionFolder(root: string, tenantId = 'default'): CompactionFolder {
  return { root, store: storeAt(root), tenantId };
}

/** hippo.db's own vector index under `root`, as embedMemory and embedAll take it. */
export function localIndex(root: string): EmbedTarget {
  return {
    embeddingIndex: storeAt(root).hippoDb.embeddingIndex,
    rows: storeAt(root),
    embeddings: loadConfig(root).embeddings,
    embedderFor: resolveEmbeddingProvider,
    failureNotices: TEST_RUN.failureNotices,
  };
}

/** The store a CLI hook is handed: hippo.db with its local files. */
export function hookStore(root: string): CliStore {
  return storeAt(root);
}
