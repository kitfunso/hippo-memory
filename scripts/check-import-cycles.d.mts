export interface ImportCycle {
  modules: string[];
  edges: [string, string][];
}

export function runtimeSpecifiers(text: string): string[];
export function findImportCycles(srcDir: string): ImportCycle[];
