// The rotation window of a webhook's previous signing secret, one rule for every connector: open until the date its
// UNTIL variable names, closed from then on.
import { log } from '../../base/util/log.js';

/** The variables that hold a connector's previous secret and the end of its rotation window. */
export interface PreviousSecretVars {
  readonly secret: string;
  readonly until: string;
}

export const SLACK_PREVIOUS: PreviousSecretVars = {
  secret: 'SLACK_SIGNING_SECRET_PREVIOUS',
  until: 'SLACK_SIGNING_SECRET_PREVIOUS_UNTIL',
};

export const GITHUB_PREVIOUS: PreviousSecretVars = {
  secret: 'GITHUB_WEBHOOK_SECRET_PREVIOUS',
  until: 'GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL',
};

const DATE_OR_ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** Epoch ms of an ISO date (00:00 UTC) or timestamp, or null; a day that rolls over, as 2026-02-31, is no date. */
function untilMs(text: string): number | null {
  const ms = Date.parse(text);
  const day = text.slice(0, 10);
  const real =
    DATE_OR_ISO.test(text) &&
    Number.isFinite(ms) &&
    new Date(Date.parse(`${day}T00:00:00Z`)).toISOString().startsWith(day);
  return real ? ms : null;
}

/** The previous secret while its window is open: with no `until` it stays open, as before; at or past `until`, or when
 * `until` is no date, it is refused with one warning, so a secret left behind stops on the day the operator named. */
export function previousSecretInForce(
  vars: PreviousSecretVars,
  previous: string | undefined,
  until: string | undefined,
  nowMs: number = Date.now(),
): string | undefined {
  if (!previous) return undefined;
  if (until === undefined || until === '') return previous;
  const end = untilMs(until);
  if (end !== null && nowMs < end) return previous;
  log.once(
    `${vars.secret}-closed`,
    'warn',
    end === null
      ? `${vars.until} is not an ISO date, so ${vars.secret} is refused`
      : `${vars.secret} expired at ${until} and is refused; remove it from the environment`,
  );
  return undefined;
}

/** One warning when a previous secret is set with no end date: it still works, but nothing will ever close it. */
export function warnIfOpenEnded(
  vars: PreviousSecretVars,
  previous: string | undefined,
  until: string | undefined,
): void {
  if (!previous || (until !== undefined && until !== '')) return;
  log.once(
    `${vars.secret}-open`,
    'warn',
    `${vars.secret} is set with no ${vars.until}, so it is accepted until it is removed; set ${vars.until} to the ` +
      'ISO date the rotation ends',
  );
}
