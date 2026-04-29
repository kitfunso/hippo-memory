import { describe, it, expect } from 'vitest';
import {
  isSlackEventEnvelope,
  isSlackMessageEvent,
  type SlackEventEnvelope,
  type SlackMessageEvent,
} from '../src/connectors/slack/types.js';

describe('slack types', () => {
  it('accepts a well-formed event envelope', () => {
    const envelope: SlackEventEnvelope = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
      event_time: 1700000000,
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1700000000.000100' },
    };
    expect(isSlackEventEnvelope(envelope)).toBe(true);
  });

  it('accepts a message_deleted subtype', () => {
    const evt = {
      type: 'message',
      subtype: 'message_deleted',
      channel: 'C1',
      deleted_ts: '1700000000.000100',
      ts: '1700000001.000200',
    };
    expect(isSlackMessageEvent(evt)).toBe(true);
    expect((evt as SlackMessageEvent).subtype).toBe('message_deleted');
  });

  it('rejects malformed envelopes', () => {
    expect(isSlackEventEnvelope({ type: 'event_callback' })).toBe(false);
    expect(isSlackEventEnvelope(null)).toBe(false);
    expect(isSlackEventEnvelope({ event_id: 'Ev1', event: {} })).toBe(false);
  });
});
