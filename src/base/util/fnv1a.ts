// A stable 32-bit hash for ids and query text, never a secure one: graph files and recall history store
// its values, so it must not change.
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over `text`'s UTF-16 code units, as an unsigned integer. */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), FNV_PRIME);
  return hash >>> 0;
}
