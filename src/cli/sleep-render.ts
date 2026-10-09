// The text `hippo sleep` prints for an api.sleep result, kept pure so tests read the lines directly.

import type * as api from '../api/index.js';
import { renderAmbientSummary } from '../core/ambient.js';

/** The lines `hippo sleep` prints for an api.sleep result; pure, so the snapshot tests read them without a console spy. */
export function sleepResultLines(result: api.SleepResult): string[] {
  return [...sleepCountLines(result), ...(result.dryRun ? ['\n(dry run  - nothing written)'] : []), ...sleepDedupeAndAuditLines(result), ...sleepShareAndGraphLines(result)];
}

function sleepCountLines(result: api.SleepResult): string[] {
  const lines = [`Running consolidation${result.dryRun ? ' (dry run)' : ''}...`, `\nResults:`, `   Active memories:  ${result.active}`, `   Removed (decayed): ${result.removed}`];
  // Only when dormant.enabled moved something, so every other render stays byte-identical.
  if (result.dormant !== undefined && result.dormant > 0) {
    lines.push(`   Kept dormant:      ${result.dormant}  (hippo dormant to list)`);
  }
  if (result.dormantExpired !== undefined && result.dormantExpired > 0) {
    lines.push(`   Expired dormant:   ${result.dormantExpired}  (past dormant.retentionDays)`);
  }
  lines.push(`   Merged episodic:   ${result.mergedEpisodic}`, `   New semantic:      ${result.newSemantic}`);
  if (result.details && result.details.length > 0) lines.push('\nDetails:', ...result.details);
  return lines;
}

function sleepDedupeAndAuditLines(result: api.SleepResult): string[] {
  const lines: string[] = [];
  if (result.deduped && result.deduped.removed > 0) {
    const { removed, semDups, epiDups, crossDups } = result.deduped;
    const parts: string[] = [];
    if (semDups > 0) parts.push(`${semDups} redundant semantic patterns`);
    if (epiDups > 0) parts.push(`${epiDups} duplicate episodic lessons`);
    if (crossDups > 0) parts.push(`${crossDups} cross-layer duplicates`);
    lines.push(`\n${result.dryRun ? 'Would dedupe' : 'Deduped'} ${removed} duplicates (${parts.join(', ')}). ${result.dryRun ? 'Would keep' : 'Kept'} stronger copies.`);
  }
  if (result.audit) {
    if (result.audit.errorsRemoved > 0) {
      lines.push(`\nAudit: ${result.dryRun ? 'would remove' : 'removed'} ${result.audit.errorsRemoved} junk memories (too short/empty).`);
    }
    if (result.audit.warningCount > 0) {
      lines.push(`Audit: ${result.audit.warningCount} low-quality memories detected (run \`hippo audit\` for details).`);
    }
  }
  return lines;
}

function sleepShareAndGraphLines(result: api.SleepResult): string[] {
  const lines: string[] = [];
  if (result.shared !== undefined && result.shared > 0) {
    lines.push(`\nAuto-shared ${result.shared} high-value memories to global store.`);
  }
  if (result.secretSkipped !== undefined && result.secretSkipped > 0) {
    // The secret veto is never silent.
    lines.push(`\nAuto-share: withheld ${result.secretSkipped} secret-flagged ${result.secretSkipped === 1 ? 'memory' : 'memories'} (secret veto).`);
  }
  if (result.ambient) lines.push(`\n${renderAmbientSummary(result.ambient)}`);
  if (result.graph && result.graph.tenants > 0) {
    const { tenants, entities, relations } = result.graph;
    lines.push(`\nGraph: rebuilt ${tenants} tenant${tenants === 1 ? '' : 's'} (${entities} entities, ${relations} relations).`);
  }
  return lines;
}
