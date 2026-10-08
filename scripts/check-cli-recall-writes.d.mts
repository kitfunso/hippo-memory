export const RECALL_ONLY: readonly string[];
export const SHARED_WRITERS: readonly string[];
export const RECALL_VERB_FILES: readonly string[];
export function namedOnLines(text: string, names: readonly string[]): { line: number; name: string }[];
export function findCliRecallWrites(srcDir: string): { file: string; line: number; name: string }[];
