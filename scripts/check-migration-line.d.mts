export interface MigrationGap {
  after: number;
  next: number;
}

export function readMigrationVersions(dir?: string): number[];
export function findMigrationGaps(versions: readonly number[]): MigrationGap[];
export function describeGap(gap: MigrationGap): string;
