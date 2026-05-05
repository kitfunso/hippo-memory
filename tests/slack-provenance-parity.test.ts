/**
 * Slack provenance parity. Mirrors tests/github-provenance-parity.test.ts.
 *
 * After ingesting a representative batch of Slack messages, every kind='raw'
 * row must satisfy the v0.40.0 envelope contract: owner + artifact_ref
 * populated, coverage 1.0. Pre-v1.4.0 the Slack transform shipped
 * `owner: undefined` for userless `bot_message` events (transform.ts:38),
 * which would have failed `hippo provenance --strict`. v1.4.0 derives
 * `bot:<bot_id>` instead. This test is the regression guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadAllEntries } from '../src/store.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { buildProvenanceCoverage } from '../src/provenance-coverage.js';
import type { ChannelMeta } from '../src/connectors/slack/scope.js';
import type { SlackMessageEvent } from '../src/connectors/slack/types.js';
import type { Context } from '../src/api.js';

const PUBLIC_CHANNEL: ChannelMeta = { id: 'C01PUB', name: 'general', isPrivate: false };
const TEAM_ID = 'T01TEAM';

function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: 'connector:slack' };
}

function makeMessage(i: number, opts: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    channel: PUBLIC_CHANNEL.id,
    user: `U${String(i).padStart(5, '0')}`,
    text: `prov-msg-${i}`,
    ts: `1700000000.${String(i).padStart(6, '0')}`,
    ...opts,
  };
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('Slack connector — provenance coverage parity', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-prov-'));
    mkdirSync(join(root, '.hippo'), { recursive: true });
    initStore(root);
  });
  afterEach(() => safeRmSync(root));

  it('every ingested user message carries owner + artifact_ref (coverage = 1.0)', () => {
    const ctx = ctxFor(root);
    for (let i = 0; i < 25; i++) {
      const msg = makeMessage(i);
      ingestMessage(ctx, {
        teamId: TEAM_ID,
        channel: PUBLIC_CHANNEL,
        message: msg,
        eventId: `Ev${i}`,
      });
    }
    const coverage = buildProvenanceCoverage(loadAllEntries(root));
    expect(coverage.gaps).toHaveLength(0);
    expect(coverage.coverage).toBe(1);

    const slackEntries = loadAllEntries(root).filter(
      (e) => e.kind === 'raw' && e.tags.includes('source:slack'),
    );
    expect(slackEntries.length).toBeGreaterThanOrEqual(25);
    for (const e of slackEntries) {
      expect(e.owner).not.toBeNull();
      expect(e.owner).toMatch(/^user:U/);
      expect(e.artifact_ref).not.toBeNull();
      expect(e.artifact_ref?.startsWith('slack://')).toBe(true);
    }
  });

  it('userless bot message gets bot:<bot_id> owner, never coverage gap', () => {
    // Slack edge case: subtype='bot_message' carries text + bot_id but no user.
    // Production must keep ingesting these. Codex round 1 P1: skipping them
    // would silently drop existing bot ingestion (ingest.ts:54-65 treats
    // null-transform as "skipped but seen"). The v0.40.0 strict gate requires
    // a non-null owner, so transform.ts derives `bot:<bot_id>`.
    const ctx = ctxFor(root);
    const userless: SlackMessageEvent = {
      type: 'message',
      subtype: 'bot_message',
      channel: PUBLIC_CHANNEL.id,
      text: 'a bot said this',
      ts: '1700000099.000099',
      bot_id: 'B01ABCD',
    };
    ingestMessage(ctx, {
      teamId: TEAM_ID,
      channel: PUBLIC_CHANNEL,
      message: userless,
      eventId: 'EvBot',
    });
    const coverage = buildProvenanceCoverage(loadAllEntries(root));
    expect(coverage.gaps).toHaveLength(0);
    const botRow = loadAllEntries(root).find(
      (e) => e.tags.includes('source:slack') && e.owner?.startsWith('bot:'),
    );
    expect(botRow?.owner).toBe('bot:B01ABCD');
    expect(botRow?.tags).toContain('bot:B01ABCD');
  });

  it('threaded reply preserves thread_ts tag and gate stays clean', () => {
    const ctx = ctxFor(root);
    const reply = makeMessage(99, { thread_ts: '1700000000.000001' });
    ingestMessage(ctx, {
      teamId: TEAM_ID,
      channel: PUBLIC_CHANNEL,
      message: reply,
      eventId: 'EvReply',
    });
    const replyRow = loadAllEntries(root).find((e) =>
      e.tags.includes('thread:1700000000.000001'),
    );
    expect(replyRow?.owner).toMatch(/^user:U/);
    expect(buildProvenanceCoverage(loadAllEntries(root)).gaps).toHaveLength(0);
  });

  it('message_changed edits do not create coverage gaps', () => {
    const ctx = ctxFor(root);
    const original = makeMessage(50);
    ingestMessage(ctx, {
      teamId: TEAM_ID, channel: PUBLIC_CHANNEL, message: original, eventId: 'EvOrig',
    });
    const edited: SlackMessageEvent = {
      ...original,
      subtype: 'message_changed',
      text: `${original.text} (edited)`,
    };
    ingestMessage(ctx, {
      teamId: TEAM_ID, channel: PUBLIC_CHANNEL, message: edited, eventId: 'EvEdit',
    });
    expect(buildProvenanceCoverage(loadAllEntries(root)).gaps).toHaveLength(0);
  });
});
