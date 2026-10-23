import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * The package folder: it holds package.json, bin/ and dist-ui/. The same three steps up from src/base/config and from
 * dist/base/config.
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
