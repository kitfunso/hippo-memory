// What a sync did, per tool, and the one line a command prints about it (plan design 11).
import { AGENT_MEMORY_TOOLS, type ToolId } from '../core/agent-memory-tools.js';
import type { Scope } from './types.js';

export interface Tally {
  imported: number;
  replaced: number;
  restored: number;
  setAside: number;
  untagged: number;
  unchanged: number;
  adopted: number;
  renamed: number;
  collapsed: number;
  retagged: number;
  handedOver: number;
  duplicate: number;
  secret: number;
  short: number;
  rejected: number;
  unread: number;
  unreadable: number;
  busy: number;
}

export function emptyTally(): Tally {
  return {
    imported: 0, replaced: 0, restored: 0, setAside: 0, untagged: 0, unchanged: 0, adopted: 0, renamed: 0, collapsed: 0, retagged: 0,
    handedOver: 0, duplicate: 0, secret: 0, short: 0, rejected: 0, unread: 0, unreadable: 0, busy: 0,
  };
}

const TALLY_FIELDS: readonly (keyof Tally)[] = Object.keys(emptyTally()).filter(isTallyField);

function isTallyField(key: string): key is keyof Tally {
  return key in emptyTally();
}

export function addTally(into: Tally, from: Tally): void {
  for (const field of TALLY_FIELDS) into[field] += from[field];
}

export interface ContainerSeen {
  readonly scope: Scope;
  readonly path: string;
  readonly store: string;
  readonly items: number;
  readonly readable: boolean;
}

export interface ToolReport {
  readonly tool: ToolId;
  readonly label: string;
  readonly homes: string[];
  readonly containers: ContainerSeen[];
  readonly tally: Tally;
  /** Dry run only: kept rows in containers this run did not list, such as a moved project's old folder. */
  unlisted: number;
}

export interface ImportReport {
  readonly tools: ToolReport[];
  readonly warnings: string[];
}

export function emptyReport(): ImportReport {
  return { tools: [], warnings: [] };
}

export function toolReport(report: ImportReport, tool: ToolId): ToolReport {
  const found = report.tools.find((t) => t.tool === tool);
  if (found) return found;
  const label = AGENT_MEMORY_TOOLS.find((t) => t.id === tool)?.label ?? tool;
  const created: ToolReport = { tool, label, homes: [], containers: [], tally: emptyTally(), unlisted: 0 };
  report.tools.push(created);
  return created;
}

export function mergeReports(into: ImportReport, from: ImportReport): void {
  for (const t of from.tools) {
    const target = toolReport(into, t.tool);
    for (const home of t.homes) if (!target.homes.includes(home)) target.homes.push(home);
    target.containers.push(...t.containers);
    addTally(target.tally, t.tally);
    target.unlisted += t.unlisted;
  }
  into.warnings.push(...from.warnings);
}

export function totalTally(report: ImportReport): Tally {
  const total = emptyTally();
  for (const t of report.tools) addTally(total, t.tally);
  return total;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const TALLY_WORDS = {
  imported: 'new', replaced: 'replaced', restored: 'brought back', setAside: 'set aside', untagged: 'pinned and kept',
  unchanged: 'unchanged', adopted: 'taken over from the old Claude import', renamed: 'moved to the project id', collapsed: 'duplicates folded', retagged: 'retagged',
  handedOver: 'handed over from the global store', duplicate: 'already stored', secret: 'skipped for a secret', short: 'too short',
  rejected: 'skipped as rejected', unread: 'files skipped', unreadable: 'unreadable folders', busy: 'busy folders',
} as const satisfies Record<keyof Tally, string>;

/** `hippo import --agents`: each tool's home, its folders and what moved; in a dry run, what would have. */
export function detailLines(report: ImportReport, dryRun: boolean): string[] {
  const lines = [dryRun ? 'Agent memories (dry run, nothing written):' : 'Agent memories:'];
  for (const t of report.tools) {
    const found = t.containers.length === 0 ? ' (no memory folders found)' : '';
    lines.push(`  ${t.label}: ${t.homes.length === 0 ? 'not found' : t.homes.join(', ')}${found}`);
    for (const c of t.containers) {
      lines.push(`    ${c.scope} ${c.path}: ${c.readable ? plural(c.items, 'note', 'notes') : 'unreadable'}, into ${c.store}`);
    }
    const moved = TALLY_FIELDS.filter((f) => t.tally[f] > 0).map((f) => `${t.tally[f]} ${TALLY_WORDS[f]}`);
    if (moved.length > 0) lines.push(`    ${dryRun ? 'would be ' : ''}${moved.join(', ')}`);
    if (t.unlisted > 0) lines.push(`    ${plural(t.unlisted, 'kept row sits', 'kept rows sit')} in folders not listed this run (a moved project's old copy)`);
  }
  return lines;
}

/** "Imported 12 agent memories (Claude Code 10, Codex 2); 1 replaced, 1 set aside, 1 skipped for a secret.", or null when nothing moved. */
export function summaryLine(report: ImportReport): string | null {
  const total = totalTally(report);
  const parts = [
    total.replaced > 0 ? `${total.replaced} replaced` : '',
    total.restored > 0 ? `${total.restored} brought back` : '',
    total.setAside > 0 ? `${total.setAside} set aside` : '',
    total.untagged > 0 ? `${plural(total.untagged, 'pinned memory', 'pinned memories')} kept with the note gone` : '',
    total.secret > 0 ? `${total.secret} skipped for a secret` : '',
    total.rejected > 0 ? `${total.rejected} skipped as rejected` : '',
  ].filter((p) => p !== '');
  if (total.imported === 0) return parts.length === 0 ? null : `Agent memories: ${parts.join(', ')}.`;
  const byTool = report.tools.filter((t) => t.tally.imported > 0).map((t) => `${t.label} ${t.tally.imported}`);
  const head = `Imported ${plural(total.imported, 'agent memory', 'agent memories')} (${byTool.join(', ')})`;
  return parts.length === 0 ? `${head}.` : `${head}; ${parts.join(', ')}.`;
}
