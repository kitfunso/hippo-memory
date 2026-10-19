// The stores the CLI root hands its capture, digest and doctor code, for tests that call that code directly.
import type { CaptureTarget } from '../../src/capture/command.js';
import type { CompactionFolder } from '../../src/capture/compaction-record.js';
import { cliLocalFiles, cliStore } from '../../src/cli/api-context.js';
import type { EmbedTarget } from '../../src/search/embed-memories.js';
import { loadConfig } from '../../src/core/config.js';
import type { Diagnostics } from '../../src/store/local/diagnostics.js';
import type { FolderFiles } from '../../src/store/local/index.js';

export function captureTarget(root: string): CaptureTarget {
  return { root, files: cliLocalFiles(root), config: loadConfig(root) };
}

export function diagnosticsAt(root: string): Diagnostics {
  return cliLocalFiles(root).diagnostics;
}

/** hippo.db's files under `root`, as the ledger takes them. */
export function folderFiles(root: string): FolderFiles {
  return { root, files: cliLocalFiles(root) };
}

/** hippo.db's files under `root` and the tenant a compaction hook writes as. */
export function compactionFolder(root: string, tenantId = 'default'): CompactionFolder {
  return { ...folderFiles(root), tenantId };
}

/** hippo.db's own vector index under `root`, as embedMemory and embedAll take it. */
export function localIndex(root: string): EmbedTarget {
  return {
    hippoRoot: root,
    embeddingIndex: cliLocalFiles(root).embeddingIndex,
    embeddings: loadConfig(root).embeddings,
  };
}

/** The store a CLI hook is handed: hippo.db with its local files. */
export { cliStore as hookStore };
