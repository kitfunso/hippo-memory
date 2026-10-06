// `hippo auth`: create, list, revoke and scope API keys.

import { openHippoDb, closeHippoDb } from '../db.js';
import { listApiKeys, type ApiKeyListItem } from '../auth.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { resolveAuthRoot } from './shared.js';

// ---------------------------------------------------------------------------
// Auth subcommands
// ---------------------------------------------------------------------------

function cmdAuthCreate(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantFlag = typeof flags['tenant'] === 'string' ? (flags['tenant'] as string) : undefined;
  const labelFlag = typeof flags['label'] === 'string' ? (flags['label'] as string) : undefined;
  const asJson = Boolean(flags['json']);

  // Accepts 'admin' | 'member' only; anything else exits 1 so a typo doesn't silently default to admin.
  const roleFlag = typeof flags['role'] === 'string' ? (flags['role'] as string) : undefined;
  let role: 'admin' | 'member' = 'admin';
  if (roleFlag !== undefined) {
    if (roleFlag !== 'admin' && roleFlag !== 'member') {
      printError(`Invalid --role value: '${roleFlag}'. Use 'admin' or 'member'.`);
      process.exit(1);
    }
    role = roleFlag;
  }

  // The CLI's --tenant flag is the only legitimate cross-tenant override
  // (admin minting a key for another tenant from the local machine). It
  // flows through ctx.tenantId, NOT through opts — authCreate's opts no
  // longer accepts a tenantId field, so the HTTP layer cannot smuggle a
  // body.tenantId across.
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: tenantFlag ?? resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const result = api.authCreate(ctx, { label: labelFlag, role });

  if (asJson) {
    console.log(JSON.stringify({
      keyId: result.keyId,
      plaintext: result.plaintext,
      tenantId: result.tenantId,
      label: labelFlag ?? null,
      role: result.role,
    }));
    return;
  }

  console.log(`key_id:    ${result.keyId}`);
  console.log(`plaintext: ${result.plaintext}`);
  console.log(`role:      ${result.role}`);
  console.log('');
  console.log('!! WARNING: this is the ONLY time the plaintext key will be shown. !!');
  console.log('!! Copy it now. Hippo stores only a scrypt hash and cannot recover it. !!');
}

function formatKeyRow(item: ApiKeyListItem): string {
  const label = item.label ?? '-';
  const created = item.createdAt;
  const expires = item.expiresAt ?? '-';
  const revoked = item.revokedAt ?? '-';
  return `${item.keyId}  ${item.tenantId}  ${item.role}  ${label}  ${created}  ${expires}  ${revoked}`;
}

function cmdAuthList(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const includeRevoked = Boolean(flags['all']);
  const asJson = Boolean(flags['json']);

  const db = openHippoDb(root);
  let items: ApiKeyListItem[];
  try {
    items = listApiKeys(db, { active: !includeRevoked });
  } finally {
    closeHippoDb(db);
  }

  if (asJson) {
    console.log(JSON.stringify(items));
    return;
  }

  if (items.length === 0) {
    console.log(includeRevoked ? 'No API keys.' : 'No active API keys. (Use --all to include revoked and expired.)');
    return;
  }

  console.log('key_id  tenant  role  label  created  expires  revoked');
  for (const item of items) {
    console.log(formatKeyRow(item));
  }
}

// The local CLI owns every tenant, so revoke and grant run in the key's own tenant.
function keyContext(root: string, keyId: string): api.Context {
  const hostCtx: api.Context = { hippoRoot: root, tenantId: resolveTenantId({}), actor: api.adminActor('cli') };
  const keyTenant = api.authKeyTenant(hostCtx, keyId);
  if (keyTenant === undefined) {
    printError(`Unknown key_id: ${keyId}`);
    process.exit(1);
  }
  return { ...hostCtx, tenantId: keyTenant };
}

function cmdAuthRevoke(hippoRoot: string, keyId: string, flags: Record<string, string | boolean | string[]>): void {
  const ctx = keyContext(resolveAuthRoot(hippoRoot, flags), keyId);
  let revokedAt: string;
  try {
    revokedAt = api.authRevoke(ctx, keyId).revokedAt;
  } catch (err) {
    printError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify({ keyId, revokedAt }));
    return;
  }
  console.log(`Revoked ${keyId} at ${revokedAt}`);
}

/** `hippo auth grant|ungrant <key_id> <scope>`, routed through api so the tenant, restricted-scope and audit checks live in one place. */
function cmdAuthScopeGrant(hippoRoot: string, keyId: string, scope: string, grant: boolean, flags: Record<string, string | boolean | string[]>): void {
  const ctx = keyContext(resolveAuthRoot(hippoRoot, flags), keyId);
  try {
    if (grant) api.authGrant(ctx, keyId, scope);
    else api.authUngrant(ctx, keyId, scope);
  } catch (err) {
    printError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify({ keyId, scope, granted: grant }));
    return;
  }
  console.log(grant ? `Granted ${keyId} read access to ${scope}` : `Removed ${keyId}'s grant on ${scope}`);
}

export function cmdAuth(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (!sub) {
    printError('Usage: hippo auth <create|list|revoke|grant|ungrant> [options]');
    process.exit(1);
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'create':
      cmdAuthCreate(hippoRoot, flags);
      return;
    case 'list':
      cmdAuthList(hippoRoot, flags);
      return;
    case 'revoke': {
      const keyId = subArgs[0];
      if (!keyId) {
        printError('Usage: hippo auth revoke <key_id>');
        process.exit(1);
      }
      cmdAuthRevoke(hippoRoot, keyId, flags);
      return;
    }
    case 'grant':
    case 'ungrant': {
      const [keyId, scope] = subArgs;
      if (!keyId || !scope) {
        printError(`Usage: hippo auth ${sub} <key_id> <scope>`);
        process.exit(1);
      }
      cmdAuthScopeGrant(hippoRoot, keyId, scope, sub === 'grant', flags);
      return;
    }
    default:
      printError(`Unknown auth subcommand: ${sub}. Expected: create | list | revoke | grant | ungrant.`);
      process.exit(1);
  }
}
