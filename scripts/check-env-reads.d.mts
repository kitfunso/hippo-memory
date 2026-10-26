export const ALLOWED: Record<string, string>;
export function envReadLines(text: string): number[];
export function findEnvReads(srcDir: string, allowed?: Record<string, string>): { file: string; line: number }[];
export const ENV_READERS: Array<[RegExp, string]>;
export function envImportLines(file: string, text: string): number[];
export function findEnvImports(srcDir: string, readers?: Array<[RegExp, string]>): { file: string; line: number }[];
