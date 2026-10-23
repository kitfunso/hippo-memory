// Reads the package's own package.json, found from src/base/config/package-root.ts.
import * as path from 'node:path';
import { PACKAGE_ROOT } from '../base/config/package-root.js';
import { isJsonObject, isJsonString } from '../base/util/json.js';
import { readJsonFile } from './json-file.js';

/** The `version` of the package's own package.json; throws when the file holds none, which npm refuses to pack. */
export function readPackageVersion(): string {
  const manifest = readJsonFile(path.join(PACKAGE_ROOT, 'package.json'));
  const version = isJsonObject(manifest) ? manifest.version : undefined;
  if (!isJsonString(version)) throw new Error(`${PACKAGE_ROOT}/package.json has no string "version"`);
  return version;
}
