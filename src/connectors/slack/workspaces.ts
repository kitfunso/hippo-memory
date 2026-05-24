/**
 * Slack workspace registration helpers (T2B follow-up, 2026-05-24).
 *
 * The `slack_workspaces` table maps Slack `team_id` → hippo `tenant_id`.
 * Empty table = single-tenant install (HIPPO_TENANT fallback).
 * Non-empty = multi-workspace install (fail-closed routing via
 * `resolveTenantForTeam`).
 *
 * Before T2B, populating this table required direct SQL — fine for a
 * single-machine deployment, awkward for operators with multiple
 * workspaces. These helpers give the CLI (`hippo slack workspaces
 * add|list|remove`) a clean surface.
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

export interface SlackWorkspace {
  teamId: string;
  tenantId: string;
  addedAt: string; // ISO timestamp
}

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
  const addedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO slack_workspaces (team_id, tenant_id, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       added_at = excluded.added_at`,
  ).run(opts.teamId, opts.tenantId, addedAt);
  return { teamId: opts.teamId, tenantId: opts.tenantId, addedAt };
}

/**
 * List all registered workspaces, sorted by team_id for stable output.
 */
export function listWorkspaces(db: DatabaseSyncLike): SlackWorkspace[] {
  const rows = db
    .prepare(
      `SELECT team_id, tenant_id, added_at FROM slack_workspaces ORDER BY team_id`,
    )
    .all() as Array<{ team_id: string; tenant_id: string; added_at: string }>;
  return rows.map((r) => ({
    teamId: r.team_id,
    tenantId: r.tenant_id,
    addedAt: r.added_at,
  }));
}

/**
 * Remove a workspace registration by team_id. Returns true if a row was
 * deleted, false if no row matched (so the CLI can report not-found
 * without a separate lookup).
 */
export function removeWorkspace(
  db: DatabaseSyncLike,
  teamId: string,
): boolean {
  const result = db
    .prepare(`DELETE FROM slack_workspaces WHERE team_id = ?`)
    .run(teamId);
  return Number(result.changes) > 0;
}
