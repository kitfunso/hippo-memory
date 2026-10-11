/** Float32 vector <-> Buffer codec for BLOB columns. */

export function float32ToBuffer(arr: number[]): Buffer {
  const f32 = new Float32Array(arr);
  return Buffer.from(f32.buffer);
}

export function bufferToFloat32(buf: Buffer | Uint8Array): number[] {
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return [];
  // Ensure we have a properly aligned copy (SQLite may return Uint8Array, not Buffer)
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const aligned = new ArrayBuffer(bytes.length);
  new Uint8Array(aligned).set(bytes);
  return Array.from(new Float32Array(aligned));
}
