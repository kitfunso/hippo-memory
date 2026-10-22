// The stores the CLI root hands its capture, digest and doctor code, for tests that call that code directly.
import type { CaptureTarget } from '../../src/surface/capture/command.js';
import type { CompactionFolder } from '../../src/surface/capture/compaction-record.js';
import { cliDiagnostics, cliStore } from '../../src/surface/cli/api-context.js';
import { folderIndex, type EmbedTarget } from '../../src/domain/search/embed-memories.js';
import { loadConfig } from '../../src/base/config/config.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import type { DoctorStore } from '../../src/surface/cli/doctor.js';
import type { StoreGroups } from '../../src/store/port.js';

export function captureTarget(root: string): CaptureTarget {
  const config = loadConfig(root);
  const store = cliStore(root);
  return { root, store, config, index: folderIndex({ store, config, embedderFor: resolveEmbeddingProvider }) };
}

export function diagnosticsBodies(root: string): DoctorStore {
  return cliDiagnostics(root);
}

/** hippo.db's ledger under `root`, with the folder facts its delivery rows name. */
export function ledgerAt(root: string): Pick<StoreGroups, 'ledger' | 'folderFiles'> {
  const { ledger, folderFiles } = cliStore(root);
  return { ledger, folderFiles };
}

/** hippo.db under `root` and the tenant a compaction hook writes as. */
export function compactionFolder(root: string, tenantId = 'default'): CompactionFolder {
  return { root, store: cliStore(root), tenantId };
}

/** hippo.db's own vector index under `root`, as embedMemory and embedAll take it. */
export function localIndex(root: string): EmbedTarget {
  return {
    embeddingIndex: cliStore(root).embeddingIndex,
    rows: cliStore(root),
    embeddings: loadConfig(root).embeddings,
    embedderFor: resolveEmbeddingProvider,
  };
}

/** The store a CLI hook is handed: hippo.db with its local files. */
export { cliStore as hookStore };
