export interface GraphWriteViolation {
  file: string;
  line: number;
  text: string;
}

export function findGraphWriteViolations(srcDir: string): GraphWriteViolation[];
