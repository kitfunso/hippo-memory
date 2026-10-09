// Builds one micro fixture's store with the built CLI: run.py's commands, in run.py's order.

import type { FixtureAction, MicroFixture, RememberItem } from './queries.ts';
import { hippoOk, initSandbox, resolveItemCwd, runHippo } from './sandbox.ts';

interface Remembered {
  readonly id: string;
  /** The directory the memory was written from, so its local store is the one later actions reach. */
  readonly cwd: string;
  readonly text: string;
  promotedId?: string;
}

export function buildMicroStore(fixture: MicroFixture, home: string): void {
  initSandbox(home);
  const remembered = fixture.remembers.map((item) => remember(fixture.name, home, item));
  for (const action of fixture.actions ?? []) applyAction(fixture.name, home, action, remembered);
}

function remember(fixture: string, home: string, item: RememberItem): Remembered {
  // A fixture writes a memory as a bare string or as an object with tags and a cwd.
  const { text, tags = [], cwd_subdir: subdir } = item instanceof Object ? item : { text: item, tags: undefined, cwd_subdir: undefined };
  const cwd = resolveItemCwd(home, subdir, fixture);
  const out = hippoOk(['remember', text, ...tags.flatMap((t) => ['--tag', t])], home, cwd);
  const id = /Remembered\s+\[([^\]]+)\]/.exec(out)?.[1];
  if (!id) throw new Error(`fixture ${fixture}: no id in the output of remember: ${out.trim()}`);
  return { id, cwd, text };
}

function applyAction(fixture: string, home: string, action: FixtureAction, remembered: Remembered[]): void {
  const target = (): Remembered => {
    const row = remembered[action.remember_index ?? -1];
    if (!row) throw new Error(`fixture ${fixture}: ${action.type} names remember[${action.remember_index}], which does not exist`);
    return row;
  };
  switch (action.type) {
    case 'supersede': {
      const row = target();
      if (!action.new_content) throw new Error(`fixture ${fixture}: supersede needs new_content`);
      hippoOk(['supersede', row.id, action.new_content], home, row.cwd);
      return;
    }
    case 'outcomes': {
      const row = target();
      for (let i = 0; i < (action.good ?? 0); i++) hippoOk(['outcome', '--good', '--id', row.id], home, row.cwd);
      for (let i = 0; i < (action.bad ?? 0); i++) hippoOk(['outcome', '--bad', '--id', row.id], home, row.cwd);
      return;
    }
    case 'recall': recallAction(fixture, home, action, remembered); return;
    case 'promote': {
      const row = target();
      row.promotedId = /\bas\s+(g_[A-Za-z0-9]+)/.exec(hippoOk(['promote', row.id], home, row.cwd))?.[1];
      return;
    }
    case 'forget': {
      const row = target();
      hippoOk(['forget', row.id], home, row.cwd);
      return;
    }
    case 'reject': rejectAction(fixture, home, action, target()); return;
    default: throw new Error(`fixture ${fixture}: unknown action type ${action.type}`);
  }
}

/** Strengthens one memory by recalling it; `--limit 1` keeps the bump to the top row, which must be the declared one. */
function recallAction(fixture: string, home: string, action: FixtureAction, remembered: Remembered[]): void {
  if (!action.query) throw new Error(`fixture ${fixture}: a recall action needs a query`);
  const times = action.times || 1;
  const index = action.remember_index ?? -1;
  const cwd = resolveItemCwd(home, action.cwd_subdir, fixture);
  let topId: string | undefined;
  for (let i = 0; i < times; i++) {
    const out = hippoOk(['recall', action.query, '--json', '--budget', '1000', '--limit', '1'], home, cwd).trim();
    const results: { id?: string }[] = out ? JSON.parse(out).results ?? [] : [];
    topId = results[0]?.id ?? topId;
  }
  const declared = remembered[index];
  // After a promote, the local copy wins at its own cwd and the promoted copy wins elsewhere; either is the target.
  const copies = declared ? [declared.id, declared.promotedId] : [];
  if (declared && topId && !copies.includes(topId)) {
    throw new Error(`fixture ${fixture}: the recall action returned ${topId}, not a copy of remember[${index}]; its query must rank the target first`);
  }
  const traced = topId ?? declared?.promotedId ?? declared?.id;
  if (index < 0 || !traced) return;
  const count: number = JSON.parse(hippoOk(['trace', traced, '--json'], home, cwd)).retrieval_count ?? 0;
  if (count < times) throw new Error(`fixture ${fixture}: the recall action left retrieval_count at ${count} for remember[${index}], below ${times}`);
}

function rejectAction(fixture: string, home: string, action: FixtureAction, row: Remembered): void {
  if (!action.reason) throw new Error(`fixture ${fixture}: a reject action needs a reason`);
  hippoOk(['reject', row.id, '--reason', action.reason], home, row.cwd);
  if (!action.reattempt) return;
  // The tombstone must refuse the same text, or a later must-not check tests a row that was never written again.
  const again = runHippo(['remember', row.text], home, row.cwd);
  if (again.status === 0 || !again.stderr.includes('rejected value')) {
    throw new Error(`fixture ${fixture}: remembering the rejected text again was not refused (exit ${again.status}): ${again.stderr.trim()}`);
  }
}
