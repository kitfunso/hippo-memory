/** The tenant of a row or a caller that names none. */
export const DEFAULT_TENANT_ID = 'default';

/** Passed for the tenant by a caller that spans every tenant on purpose. A symbol, since any
 * string is a tenant id. */
export const ALL_TENANTS: unique symbol = Symbol.for('hippo-memory.all-tenants');

/** One tenant's id, or ALL_TENANTS. */
export type TenantId = string | typeof ALL_TENANTS;
