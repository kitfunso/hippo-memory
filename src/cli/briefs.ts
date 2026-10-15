// The project brief verbs: one repo's brief, versioned by supersession and refreshable from the repo's receipts.

import * as briefsModule from '../objects/project-briefs.js';
import { errorMessage } from '../util/log.js';
import { printError } from './output.js';
import { boolFlag, stringFlag, type CliFlags } from './flag-values.js';
import { fail } from './exit.js';
import type { Objects } from '../store/port.js';
import { requiredText, versionedVerbs, type VersionedKind } from './versioned-verbs.js';

function printBriefRow(b: briefsModule.ProjectBrief): void {
  console.log(`#${b.id} [${b.status}] v${b.version} repo="${b.repo}" memory=${b.memoryId ?? '-'}`);
  if (b.changeSummary) console.log(`    change: ${b.changeSummary}`);
}

async function briefRefresh(
  objects: Objects,
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const repoRaw = args[1];
  if (!repoRaw) {
    fail('Usage: hippo brief refresh "<repo>" [--dry-run]');
  }
  const dryRun = boolFlag(flags, 'dry-run');
  try {
    if (dryRun) {
      const { markdown, receiptCount } = await briefsModule.briefFromReceipts(objects, tenantId, repoRaw);
      printError(`(dry-run: assembled from ${receiptCount} receipt(s); brief NOT written)`);
      console.log(markdown);
      return;
    }
    const created = await briefsModule.refreshedBrief(objects, { hippoRoot, tenantId, actor: 'cli' }, repoRaw);
    console.log(`Project brief #${created.id} recorded (v${created.version}) for repo "${created.repo}".`);
    if (created.changeSummary) console.log(`  change: ${created.changeSummary}`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    fail(errorMessage(e));
  }
}

const briefKind = (
  objects: Objects,
  hippoRoot: string,
  tenantId: string,
): VersionedKind<briefsModule.ProjectBrief, briefsModule.BriefStatus, string> => ({
  names: { cmd: 'brief', noun: 'Project brief', idLabel: 'brief' },
  plural: 'project briefs',
  states: briefsModule.VALID_BRIEF_STATES,
  usage: [
    'Usage: hippo brief new "<repo>" --summary "<text>"',
    '       hippo brief list [--status active|superseded|closed|all] [--repo "<repo>"] [--limit N]',
    '       hippo brief get <id>',
    '       hippo brief supersede <id> --summary "<text>" [--change "<summary>"]',
    '       hippo brief close <id>',
    '       hippo brief refresh "<repo>" [--dry-run]   (auto-assemble the brief from the repo\'s receipts)',
  ],
  supersedeUsage: 'Usage: hippo brief supersede <id> --summary "<text>" [--change "<summary>"]',
  bodyRequired: '--summary "<text>"',
  body: (flags) => requiredText(flags, 'summary'),
  keyOf: (b) => b.repo,
  save: (repo, summary, extraTags, from) =>
    briefsModule.saveProjectBrief(objects, hippoRoot, tenantId, {
      repo,
      summary,
      extraTags,
      changeSummary: from?.changeSummary,
      supersedesBriefId: from?.id,
    }),
  recorded: (b) => `Project brief recorded: #${b.id} (v${b.version}) for repo "${b.repo}"`,
  list: (opts, flags) =>
    briefsModule.loadProjectBriefs(objects, tenantId, {
      ...opts,
      repo: stringFlag(flags, 'repo')?.trim() || undefined,
    }),
  loadById: (id) => briefsModule.loadProjectBriefById(objects, tenantId, id),
  close: (id) => briefsModule.closeProjectBrief(objects, tenantId, id),
  printRow: printBriefRow,
  printDetail: (b) => {
    console.log(`  repo: ${b.repo}`);
    console.log(`  status: ${b.status}`);
    console.log(`  version: ${b.version}`);
    console.log(`  summary: ${b.summary}`);
  },
  extra: { sub: 'refresh', run: (args, flags) => briefRefresh(objects, hippoRoot, tenantId, args, flags) },
});

export const handleProjectBrief = versionedVerbs(briefKind);
