// ALL_TENANTS is a symbol, which postMessage cannot copy to a store worker, so a job sends null in its place with where
// it sat, and the worker puts it back.
import { ALL_TENANTS } from '../../base/util/tenant.js';

/** An argument's index, and the property of that argument ALL_TENANTS sat in, or null when it was the argument. */
export type TenantMark = readonly [number, string | null];

/** A job's arguments as postMessage can copy them, and where each ALL_TENANTS sat. */
export interface MarkedArgs {
  readonly args: readonly unknown[];
  readonly allTenants: readonly TenantMark[];
}

/** `args` with each ALL_TENANTS, given as an argument or as a property of a plain-object one, swapped for null. */
export function markAllTenants(args: readonly unknown[]): MarkedArgs {
  const allTenants: TenantMark[] = [];
  const sent = args.map((arg, i) => {
    if (arg === ALL_TENANTS) {
      allTenants.push([i, null]);
      return null;
    }
    if (arg === null || arg === undefined || Object.getPrototypeOf(arg) !== Object.prototype) return arg;
    const keys = Object.entries(arg).flatMap(([key, value]) => (value === ALL_TENANTS ? [key] : []));
    for (const key of keys) allTenants.push([i, key]);
    return keys.length === 0 ? arg : { ...arg, ...Object.fromEntries(keys.map((key) => [key, null])) };
  });
  return { args: sent, allTenants };
}

/** The arguments `markAllTenants` was given, from what it sent. */
export function restoreAllTenants(args: readonly unknown[], marks: readonly TenantMark[]): unknown[] {
  const out = [...args];
  for (const [i, key] of marks) {
    const arg = out[i];
    if (key === null) out[i] = ALL_TENANTS;
    else if (arg !== null && arg !== undefined) out[i] = { ...arg, [key]: ALL_TENANTS };
  }
  return out;
}
