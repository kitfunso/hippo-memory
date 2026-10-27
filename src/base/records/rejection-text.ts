// Which text a rejection names and which rows it may remove: the rules a store applies inside its
// write, so the caller sends data and no function crosses the port.
import { BadRequestError, memoryNotFoundText } from '../errors/api-errors.js';
import { isPersonalScope, ownScopeTouches } from '../scope/recall-scope.js';
import { onlyRedacted, redactSecretsStrict } from '../util/secret-detect.js';

/** What a rejection asks for: a memory's current text by id, or a value the caller states. */
export interface RejectedTextRequest {
  readonly tenantId: string;
  readonly memoryId?: string;
  readonly value?: string;
}

/** The row a rejection by id names, as the store read it. */
type RejectedRow = {
  readonly content: string;
  readonly tenant_id: string;
  readonly scope: string | null;
};

/** The text to reject: the named row's, which must sit in the tenant and not be personal, else
 * the stated value; either must name something once its secrets are redacted. */
export function rejectedText(
  request: RejectedTextRequest,
  row: RejectedRow | undefined,
): string {
  const text = requestedText(request, row);
  // A tombstone digests the stored form, and one of markers alone would refuse every secret.
  if (onlyRedacted(redactSecretsStrict(text))) {
    const target = request.memoryId ?? '<id>';
    throw new BadRequestError(
      `The value is all secret text, so a tombstone would name nothing; remove its memory with hippo forget ${target}.`,
    );
  }
  return text;
}

function requestedText(
  request: RejectedTextRequest,
  row: RejectedRow | undefined,
): string {
  if (request.memoryId === undefined) {
    if (request.value === undefined) {
      throw new BadRequestError('reject requires either a memory id or a value.');
    }
    return request.value;
  }
  if (!row || row.tenant_id !== request.tenantId) {
    throw new Error(memoryNotFoundText(request.memoryId));
  }
  // A tombstone is tenant-wide, so one made from personal text would show its reason to everyone.
  if (isPersonalScope(row.scope)) {
    throw new BadRequestError("Personal memories can't be rejected. Use forget to remove it.");
  }
  return row.content;
}

/** True for a row the rejection may remove: any but another person's personal row. */
export function rejectionReaches(
  ownScope: string | null,
  scope: string | null | undefined,
): boolean {
  return ownScopeTouches(ownScope, scope ?? null);
}
