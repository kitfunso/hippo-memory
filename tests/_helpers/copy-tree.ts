import { chmodSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** cpSync that keeps each folder's mode: Node 24 makes the copies with the default mode, so a copied store would be
 * wider than the owner-only one hippo made, and its open would warn. */
export function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  keepFolderModes(from, to);
}

function keepFolderModes(from: string, to: string): void {
  chmodSync(to, statSync(from).mode & 0o777);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) keepFolderModes(join(from, entry.name), join(to, entry.name));
  }
}
