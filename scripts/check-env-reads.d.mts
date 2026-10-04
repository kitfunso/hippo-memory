export const ALLOWED: Record<string, string>;
export function envReadLines(text: string): number[];
export function findEnvReads(srcDir: string, allowed?: Record<string, string>): { file: string; line: number }[];
