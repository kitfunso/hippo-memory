export {
  slackEventSeenAt as hasSeenEvent,
  markSlackEventSeenAt as markEventSeen,
  slackEventMemoryAt as lookupMemoryByEvent,
} from '../../store/connectors/slack.js';

/**
 * Thrown by the ingest afterWrite hook when a concurrent worker has already
 * inserted slack_event_log for the same event_id. The throw propagates out of
 * writeEntry's SAVEPOINT, rolling back the duplicate memory write so exactly
 * one memory row exists per Slack event_id even under two-worker races.
 *
 * Caller maps to `{status: 'skipped_duplicate'}` at the public API boundary.
 */
export class DuplicateEventError extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(`duplicate slack event_id: ${eventId}`);
    this.name = 'DuplicateEventError';
    this.eventId = eventId;
  }
}
