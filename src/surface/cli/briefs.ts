// The project brief verbs: one repo's brief, versioned by supersession and refreshable from the repo's receipts.

import { briefDigest, briefRefresh } from '../../api/objects/object-kinds.js';
import type { Context } from '../../api/types.js';
import type { ProjectBrief } from '../../base/records/object-types.js';
import { errorMessage } from '../../base/util/log.js';
import { printError } from './output.js';
import { boolFlag, type CliFlags } from './flag-values.js';
import { fail } from './exit.js';
import { requiredText, versionedVerbs, type VersionedKind } from './versioned-verbs.js';

function printBriefRow(b: ProjectBrief): void {
  console.log(`#${b.id} [${b.status}] v${b.version} repo="${b.repo}" memory=${b.memoryId ?? '-'}`);
  if (b.changeSummary) console.log(`    change: ${b.changeSummary}`);
}

async function refreshBrief(ctx: Context, args: string[], flags: CliFlags): Promise<void> {
  const repoRaw = args[1];
  if (!repoRaw) {
    fail('Usage: hippo brief refresh "<repo>" [--dry-run]');
  }
  const dryRun = boolFlag(flags, 'dry-run');
  try {
    if (dryRun) {
      const { markdown, receiptCount } = await briefDigest(ctx, repoRaw);
      printError(`(dry-run: assembled from ${receiptCount} receipt(s); brief NOT written)`);
      console.log(markdown);
      return;
    }
    const created = await briefRefresh(ctx, repoRaw);
    console.log(`Project brief #${created.id} recorded (v${created.version}) for repo "${created.repo}".`);
    if (created.changeSummary) console.log(`  change: ${created.changeSummary}`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    fail(errorMessage(e));
  }
}

const briefKind: VersionedKind<'project_brief', string> = {
  kind: 'project_brief',
  names: { cmd: 'brief', noun: 'Project brief', idLabel: 'brief' },
  plural: 'project briefs',
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
  write: (repo, summary, from) => ({ repo, summary, changeSummary: from?.changeSummary, supersedesBriefId: from?.id }),
  recorded: (b) => `Project brief recorded: #${b.id} (v${b.version}) for repo "${b.repo}"`,
  filterFlag: 'repo',
  printRow: printBriefRow,
  printDetail: (b) => {
    console.log(`  repo: ${b.repo}`);
    console.log(`  status: ${b.status}`);
    console.log(`  version: ${b.version}`);
    console.log(`  summary: ${b.summary}`);
  },
  extra: { sub: 'refresh', run: refreshBrief },
};

export const handleProjectBrief = versionedVerbs(briefKind);
