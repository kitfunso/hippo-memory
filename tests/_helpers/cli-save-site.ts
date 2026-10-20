import { loadConfig } from '../../src/base/config/config.js';
import type { ObjectByKind, SavableKind } from '../../src/base/records/object-types.js';
import { CLI_ACTOR } from '../../src/base/scope/actor.js';
import type { SavableDescriptor } from '../../src/domain/objects/descriptor.js';
import { saveObject, type ObjectSaveSite } from '../../src/domain/objects/lifecycle.js';
import { objectsAt } from './objects-at.js';

/** Where a CLI save on `root` records an object: that root's half-life, under the CLI actor. */
function cliSaveSite(root: string, tenantId: string): ObjectSaveSite {
  return { baseHalfLifeDays: loadConfig(root).defaultHalfLifeDays, tenantId, actor: CLI_ACTOR };
}

/** Saves one object of kind `d` on the hippo.db under `root` as the CLI would. */
export function cliSave<K extends SavableKind, W>(
  root: string,
  tenantId: string,
  d: SavableDescriptor<K, W>,
  write: W,
): Promise<ObjectByKind[K]> {
  return saveObject(objectsAt(root), d, cliSaveSite(root, tenantId), write);
}
