/**
 * Optional embedding-based semantic search for Hippo.
 * Uses @xenova/transformers (local, zero API keys, ~22MB model).
 * Falls back silently if the library is not installed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { MemoryEntry } from './memory.js';
import { loadAllEntries } from './store.js';
import { openHippoDb, closeHippoDb, getMeta, setMeta } from './db.js';
import { initializeParticle, savePhysicsState, loadPhysicsState, resetAllPhysicsState } from './physics-state.js';
import { loadConfig } from './config.js';

// Use createRequire for synchronous module resolution check in ESM
const _require = createRequire(import.meta.url);

// Cached availability check
let _embeddingAvailable: boolean | null = null;

// Lazy-loaded pipeline (expensive to initialize)
const _pipelineInstances = new Map<string, unknown>();
const _pipelineLoading = new Map<string, Promise<unknown>>();

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_MODEL_META_KEY = 'embedding_model';

// Use Function constructor to bypass TypeScript static module resolution
// for optional peer dependencies that may not be installed.
const _dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;

/**
 * Check (synchronously) if @xenova/transformers or @huggingface/transformers is installed.
 */
export function isEmbeddingAvailable(): boolean {
  if (_embeddingAvailable !== null) return _embeddingAvailable;

  try {
    _require.resolve('@xenova/transformers');
    _embeddingAvailable = true;
    return true;
  } catch {
    // fall through
  }

  try {
    _require.resolve('@huggingface/transformers');
    _embeddingAvailable = true;
    return true;
  } catch {
    // fall through
  }

  _embeddingAvailable = false;
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPipeline(model: string): Promise<any> {
  if (_pipelineInstances.has(model)) return _pipelineInstances.get(model);
  if (_pipelineLoading.has(model)) return _pipelineLoading.get(model);

  const loading = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let pipelineFn: any = null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await _dynImport('@xenova/transformers') as any;
      pipelineFn = mod.pipeline ?? mod.default?.pipeline;
    } catch {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await _dynImport('@huggingface/transformers') as any;
        pipelineFn = mod.pipeline ?? mod.default?.pipeline;
      } catch {
        return null;
      }
    }

    if (!pipelineFn) return null;

    try {
      const instance = await pipelineFn('feature-extraction', model, { quantized: true });
      _pipelineInstances.set(model, instance);
      return instance;
    } catch {
      return null;
    } finally {
      _pipelineLoading.delete(model);
    }
  })();

  _pipelineLoading.set(model, loading);
  return loading;
}

export function resolveEmbeddingModel(hippoRoot: string, explicitModel?: string): string {
  const direct = explicitModel?.trim();
  if (direct) return direct;

  try {
    const configured = loadConfig(hippoRoot).embeddings.model?.trim();
    if (configured) return configured;
  } catch {
    // Fall back to the default model when config cannot be read.
  }

  return DEFAULT_EMBEDDING_MODEL;
}

function loadStoredEmbeddingModel(hippoRoot: string): string | null {
  try {
    const db = openHippoDb(hippoRoot);
    try {
      const model = getMeta(db, EMBEDDING_MODEL_META_KEY, '').trim();
      return model || null;
    } finally {
      closeHippoDb(db);
    }
  } catch {
    return null;
  }
}

function saveStoredEmbeddingModel(hippoRoot: string, model: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    setMeta(db, EMBEDDING_MODEL_META_KEY, model);
  } finally {
    closeHippoDb(db);
  }
}

export function resolveIndexedEmbeddingModel(
  hippoRoot: string,
  index: Record<string, number[]> = loadEmbeddingIndex(hippoRoot),
): string | null {
  const stored = loadStoredEmbeddingModel(hippoRoot);
  if (stored) return stored;
  return Object.keys(index).length > 0 ? DEFAULT_EMBEDDING_MODEL : null;
}

export function embeddingModelRequiresReindex(
  hippoRoot: string,
  model: string,
  index: Record<string, number[]> = loadEmbeddingIndex(hippoRoot),
): boolean {
  const indexedModel = resolveIndexedEmbeddingModel(hippoRoot, index);
  return indexedModel !== null && indexedModel !== model;
}

async function rebuildEmbeddingIndex(
  entries: MemoryEntry[],
  model: string,
): Promise<Record<string, number[]>> {
  const rebuilt: Record<string, number[]> = {};

  for (const entry of entries) {
    const text = `${entry.content} ${entry.tags.join(' ')}`.trim();
    const vector = await getEmbedding(text, model);
    if (vector.length > 0) {
      rebuilt[entry.id] = vector;
    }
  }

  return rebuilt;
}

function resetPhysicsFromIndex(
  hippoRoot: string,
  entries: MemoryEntry[],
  index: Record<string, number[]>,
): void {
  try {
    const db = openHippoDb(hippoRoot);
    try {
      resetAllPhysicsState(db, entries, index);
    } finally {
      closeHippoDb(db);
    }
  } catch {
    // Physics reset is best-effort; retrieval will still fall back gracefully.
  }
}

/**
 * Get an embedding vector for a piece of text.
 * Returns an empty array if transformers is not available or fails.
 */
export async function getEmbedding(
  text: string,
  model = DEFAULT_EMBEDDING_MODEL
): Promise<number[]> {
  if (!isEmbeddingAvailable()) return [];

  try {
    const pipe = await loadPipeline(model);
    if (!pipe) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await pipe(text, { pooling: 'mean', normalize: true }) as any;
    return Array.from(output.data as Float32Array);
  } catch {
    return [];
  }
}

/**
 * Cosine similarity between two vectors. Handles unnormalized vectors.
 * Returns 0 for empty or mismatched vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-10) return 0;
  // Clamp to [-1, 1] to handle floating point drift
  return Math.min(1, Math.max(-1, dot / denom));
}

const EMBEDDINGS_FILE = 'embeddings.json';

/**
 * Load the cached embedding index from disk.
 * Returns an empty object if the file doesn't exist or is corrupt.
 */
export function loadEmbeddingIndex(hippoRoot: string): Record<string, number[]> {
  const fp = path.join(hippoRoot, EMBEDDINGS_FILE);
  if (!fs.existsSync(fp)) return {};
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, number[]>;
  } catch {
    return {};
  }
}

/**
 * Save the embedding index to disk.
 */
export function saveEmbeddingIndex(hippoRoot: string, index: Record<string, number[]>): void {
  const fp = path.join(hippoRoot, EMBEDDINGS_FILE);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
  try {
    fs.renameSync(tmp, fp);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// Mutex to serialize embedding writes and prevent read-modify-write races
let _embedWriteLock: Promise<void> = Promise.resolve();

async function withEmbedLock<T>(fn: () => Promise<T>): Promise<T> {
  let resolve!: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  const prev = _embedWriteLock;
  _embedWriteLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

/**
 * Embed a single memory entry and cache the result in the embedding index.
 */
export async function embedMemory(
  hippoRoot: string,
  entry: MemoryEntry,
  model?: string
): Promise<void> {
  if (!isEmbeddingAvailable()) return;

  return withEmbedLock(async () => {
    const effectiveModel = resolveEmbeddingModel(hippoRoot, model);
    const existingIndex = loadEmbeddingIndex(hippoRoot);

    if (embeddingModelRequiresReindex(hippoRoot, effectiveModel, existingIndex)) {
      const entries = loadAllEntries(hippoRoot);
      const rebuiltIndex = await rebuildEmbeddingIndex(entries, effectiveModel);
      saveEmbeddingIndex(hippoRoot, rebuiltIndex);
      saveStoredEmbeddingModel(hippoRoot, effectiveModel);
      resetPhysicsFromIndex(hippoRoot, entries, rebuiltIndex);
      return;
    }

    const text = `${entry.content} ${entry.tags.join(' ')}`.trim();
    const vector = await getEmbedding(text, effectiveModel);
    if (vector.length === 0) return;

    const index = existingIndex;
    index[entry.id] = vector;
    saveEmbeddingIndex(hippoRoot, index);
    saveStoredEmbeddingModel(hippoRoot, effectiveModel);

    // Initialize physics state for this memory
    try {
      const db = openHippoDb(hippoRoot);
      try {
        const existing = loadPhysicsState(db, [entry.id]);
        if (!existing.has(entry.id)) {
          const particle = initializeParticle(entry, vector);
          savePhysicsState(db, [particle]);
        }
      } finally {
        closeHippoDb(db);
      }
    } catch {
      // Physics init is best-effort — don't break embedding
    }
  });
}

/**
 * Embed all entries in hippoRoot that don't already have cached vectors.
 * Prunes orphaned embeddings for memories that no longer exist.
 * Returns the count of newly embedded entries.
 */
export async function embedAll(
  hippoRoot: string,
  model?: string
): Promise<number> {
  if (!isEmbeddingAvailable()) return 0;

  return withEmbedLock(async () => {
    const effectiveModel = resolveEmbeddingModel(hippoRoot, model);
    const entries = loadAllEntries(hippoRoot);
    const index = loadEmbeddingIndex(hippoRoot);

    if (embeddingModelRequiresReindex(hippoRoot, effectiveModel, index)) {
      const rebuiltIndex = await rebuildEmbeddingIndex(entries, effectiveModel);
      saveEmbeddingIndex(hippoRoot, rebuiltIndex);
      saveStoredEmbeddingModel(hippoRoot, effectiveModel);
      resetPhysicsFromIndex(hippoRoot, entries, rebuiltIndex);
      return Object.keys(rebuiltIndex).length;
    }

    let count = 0;
    let dirty = false;

    // Prune orphaned embeddings for deleted memories
    const activeIds = new Set(entries.map((e) => e.id));
    for (const id of Object.keys(index)) {
      if (!activeIds.has(id)) {
        delete index[id];
        dirty = true;
      }
    }

    for (const entry of entries) {
      if (index[entry.id]) continue; // already embedded

      const text = `${entry.content} ${entry.tags.join(' ')}`.trim();
      const vector = await getEmbedding(text, effectiveModel);
      if (vector.length > 0) {
        index[entry.id] = vector;
        count++;
        dirty = true;
      }
    }

    if (dirty) {
      saveEmbeddingIndex(hippoRoot, index);
    }
    saveStoredEmbeddingModel(hippoRoot, effectiveModel);

    return count;
  });
}
