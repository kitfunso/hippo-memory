/** `storedVectors` with no number[] copy, for a store that holds vectors as Float32 bytes. */
export interface VectorViews {
  /** The same ids and values as `VectorReads.storedVectors`, each value a Float32 view. */
  storedVectorViews(ids: readonly string[]): Promise<Map<string, Float32Array>>;
}
