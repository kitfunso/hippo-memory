export interface ImportCycle {
  modules: string[];
  edges: [string, string][];
}

export interface FolderCycle {
  folders: string[];
  edges: [string, string][];
}

export interface AllowedFolderCycle {
  folders: string[];
  why: string;
}

export function runtimeSpecifiers(text: string): string[];
export function findImportCycles(srcDir: string): ImportCycle[];
export function findFolderCycles(srcDir: string): FolderCycle[];
export const FOLDER_CYCLE_ALLOWLIST: readonly AllowedFolderCycle[];
export function judgeFolderCycles(
  cycles: readonly FolderCycle[],
  allowlist: readonly AllowedFolderCycle[],
): { unlisted: FolderCycle[]; stale: AllowedFolderCycle[] };
