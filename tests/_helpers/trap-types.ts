// Shapes of the untyped benchmarks/sequential-learning/traps.mjs exports, for tests that read them.
export interface TrapCategory { id: string; lesson: string; tags: string[]; recallQueries: string[] }
export interface TrapPlacement { category: string; positions: number[]; adversarial?: boolean }
export interface TrapTask { id: number; description: string; trapCategory: string | null; recallQuery: string }
