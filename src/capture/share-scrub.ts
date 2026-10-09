// The scrub for transcript text that leaves the machine it was typed on.
import { maskHomePaths } from '../util/home-path.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';

/** Secrets first, then emails, then home paths: a home-path mask could split a secret so that no pattern matches it. */
export function scrubForSharing(text: string): string {
  return maskHomePaths(maskEmails(redactSecretsStrict(text)));
}
