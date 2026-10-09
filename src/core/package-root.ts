import * as path from 'path';
import { fileURLToPath } from 'url';

/** The package folder: it holds package.json, bin/ and dist-ui/. The same two steps up from src/core and from dist/core. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
