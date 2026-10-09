// Sleep and the daily runner clean a store's old automatic memories once, so an upgrade needs no command.

import * as path from 'path';
import { errorMessage, log } from '../util/log.js';
import { repairQualityOnce } from './quality-repair.js';
import { getGlobalRoot } from '../sharing/shared.js';
import { resolveTenantId } from '../store/tenant.js';

/** Fault-isolated like the project tag repair: a failure warns, leaves the store unmarked and runs again next time. */
export function repairQualityOnceAt(root: string): void {
  try {
    const result = repairQualityOnce(root, resolveTenantId({}));
    if (result === null) return;
    if (!result.supported) {
      log.warn(`memory quality repair skipped, tried again next time: ${result.blockers.join('; ')}`);
      return;
    }
    // A sleep run from a folder with no project store can resolve to the global store too.
    const scope = path.resolve(root) === path.resolve(getGlobalRoot()) ? ' --global' : '';
    const moved = result.appliedIds.length;
    if (moved > 0) {
      console.log(`Set aside ${moved} automatic ${moved === 1 ? 'memory' : 'memories'} with a certain defect, once after the upgrade (backup: ${result.backup}).`);
      console.log(`  List them: hippo dormant${scope}   Bring one back: hippo dormant restore <id>${scope}`);
    }
    const review = result.issues.filter((issue) => issue.disposition === 'review').length;
    if (review > 0) {
      const lead = moved > 0 ? `  ${review} more` : `Checked old automatic memories once after the upgrade: ${review}`;
      console.log(`${lead} ${review === 1 ? 'looks' : 'look'} doubtful and ${review === 1 ? 'was' : 'were'} kept; hippo audit repair${scope} lists them.`);
    }
    for (const warning of result.warnings) log.warn(warning);
  } catch (err) {
    log.warn(`memory quality repair skipped, tried again next time: ${errorMessage(err)}`);
  }
}
