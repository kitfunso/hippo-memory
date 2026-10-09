/**
 * Slack workspace registration helpers.
 *
 * The `slack_workspaces` table maps Slack `team_id` → hippo `tenant_id`.
 * Empty table = single-tenant install (HIPPO_TENANT fallback).
 * Non-empty = multi-workspace install (fail-closed routing via
 * `resolveTenantForTeam`).
 *
 * These helpers give the CLI (`hippo slack workspaces add|list|remove`) a
 * surface, so operators with multiple workspaces need no direct SQL.
 *
 * Design choices:
 *   - `add` is an upsert (ON CONFLICT UPDATE). Re-registering an
 *     existing team_id with a different tenant_id intentionally
 *     overwrites — operators move workspaces between tenants and the
 *     CLI shouldn't require a delete+add dance.
 *   - `list` sorts by team_id for stable output.
 *   - `remove` returns a boolean for the CLI to distinguish "removed"
 *     from "not found" without an extra SELECT.
 */

import type { DatabaseSyncLike } from '../../db.js';
import { upsertSlackWorkspaceAt, type SlackWorkspace } from '../../store/connectors/slack.js';

export type { SlackWorkspace };
export { listSlackWorkspacesAt as listWorkspaces, removeSlackWorkspaceAt as removeWorkspace } from '../../store/connectors/slack.js';

export interface AddWorkspaceOpts {
  teamId: string;
  tenantId: string;
}

/**
 * Register or re-register a Slack team → tenant mapping. Upserts on
 * team_id conflict (operators move workspaces between tenants).
 */
export function addWorkspace(
  db: DatabaseSyncLike,
  opts: AddWorkspaceOpts,
): SlackWorkspace {
  return upsertSlackWorkspaceAt(db, opts.teamId, opts.tenantId);
}
