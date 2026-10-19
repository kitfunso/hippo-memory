import * as path from 'path';
import { fileURLToPath } from 'url';
import { isJsonObject, isJsonString, readJsonFile } from '../util/json.js';

/**
 * The package folder: it holds package.json, bin/ and dist-ui/. The same two steps up from src/core and from dist/core.
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `version` of the package's own package.json; throws when the file holds none, which npm refuses to pack. */
export function readPackageVersion(): string {
  const manifest = readJsonFile(path.join(PACKAGE_ROOT, 'package.json'));
  const version = isJsonObject(manifest) ? manifest.version : undefined;
  if (!isJsonString(version)) throw new Error(`${PACKAGE_ROOT}/package.json has no string "version"`);
  return version;
}
