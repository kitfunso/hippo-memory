// A key column is looked up by the value a caller sent, so a secret-shaped key is refused, never
// redacted: a redacted key would merge two callers' rows or lose the one asked for.
import { BadRequestError } from './api-errors.js';
import { redactSecretsStrict } from '../util/secret-detect.js';

/** Throws for the first field whose value holds secret-shaped text, naming the field, never the value. */
export function refuseSecretKeys(
  fields: Readonly<Record<string, string | null | undefined>>,
): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value && redactSecretsStrict(value) !== value) {
      throw new BadRequestError(
        `${field} holds secret-shaped text; it is a key stored as given, so send one with no secret in it.`,
      );
    }
  }
}

/** refuseSecretKeys over a list, each value named `field[i]`. */
export function refuseSecretKeyList(field: string, values: readonly string[] | undefined): void {
  refuseSecretKeys(Object.fromEntries((values ?? []).map((value, i) => [`${field}[${i}]`, value])));
}
