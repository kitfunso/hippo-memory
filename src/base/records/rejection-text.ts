// Which text a rejection names and which rows it may remove: the rules a store applies inside its write, so the caller
// sends data and no function crosses the port.
import { BadRequestError } from '../errors/api-errors.js';
import { isPersonalScope, ownScopeTouches } from '../scope/recall-scope.js';

/** What a rejection asks for: a memory's current text by id, or a value the caller states. */
export interface RejectedTextRequest {
  readonly tenantId: string;
  readonly memoryId?: string;
  readonly value?: string;
}

/** The text to reject: the named row's, which must sit in the tenant and not be personal, else the stated value. */
export function rejectedText(
  request: RejectedTextRequest,
  row: { readonly content: string; readonly tenant_id: string; readonly scope: string | null } | undefined,
): string {
  if (request.memoryId === undefined) {
    if (request.value === undefined) throw new BadRequestError('reject requires either a memory id or a value.');
    return request.value;
  }
  if (!row || row.tenant_id !== request.tenantId) throw new Error(`memory not found: ${request.memoryId}`);
  // A tombstone is tenant-wide, so one made from personal text would show its reason to everyone.
  if (isPersonalScope(row.scope)) {
    throw new BadRequestError("Personal memories can't be rejected. Use forget to remove it.");
  }
  return row.content;
}

/** True for a row the rejection may remove: any but another person's personal row. */
export function rejectionReaches(ownScope: string | null, scope: string | null | undefined): boolean {
  return ownScopeTouches(ownScope, scope ?? null);
}
