// `hippo auth`: create, list, revoke and scope API keys.

import { openHippoDb, closeHippoDb } from '../db.js';
import { listApiKeys, type ApiKeyListItem } from '../store/auth.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { type CliFlags, resolveAuthRoot, boolFlag, stringFlag } from './shared.js';
import { errorMessage } from '../log.js';

// ---------------------------------------------------------------------------
// Auth subcommands
// ---------------------------------------------------------------------------

/** --role as given, or undefined for the default; anything else exits 1, so a typo never picks a role. */
function roleFlagOrExit(flags: CliFlags): 'admin' | 'member' | undefined {
  const roleFlag = stringFlag(flags, 'role');
  if (roleFlag !== undefined && roleFlag !== 'admin' && roleFlag !== 'member') {
    printError(`Invalid --role value: '${roleFlag}'. Use 'admin' or 'member'.`);
    process.exit(1);
  }
  return roleFlag;
}

/** Says which defaults a mint took and how to ask for the wider key. Stderr keeps --json output clean. */
function noteMintDefaults(roleGiven: boolean, expiryGiven: boolean): void {
  const notes: string[] = [];
  if (!roleGiven) notes.push('no --role given, so this is a member key (pass --role admin for an admin key)');
  if (!expiryGiven) notes.push('no --ttl-days or --no-expiry given, so it expires in 90 days');
  if (notes.length > 0) printError(`hippo auth create: ${notes.join('; ')}.`);
}

function cmdAuthCreate(hippoRoot: string, flags: CliFlags): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantFlag = stringFlag(flags, 'tenant');
  const labelFlag = stringFlag(flags, 'label');
  const asJson = boolFlag(flags, 'json');
  const role = roleFlagOrExit(flags);
  const ttlFlag = stringFlag(flags, 'ttl-days');
  const ttlDays = ttlFlag === undefined ? undefined : Number(ttlFlag);
  const noExpiry = boolFlag(flags, 'no-expiry');

  // The CLI's --tenant flag is the only legitimate cross-tenant override
  // (admin minting a key for another tenant from the local machine). It
  // flows through ctx.tenantId, NOT through opts — authCreate's opts no
  // longer accepts a tenantId field, so the HTTP layer cannot smuggle a
  // body.tenantId across.
  const ctx: api.HippoDbContext = {
    hippoRoot: root,
    tenantId: tenantFlag ?? resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  let result: api.AuthCreateResult;
  try {
    result = api.authCreate(ctx, { label: labelFlag, role, ttlDays, noExpiry: noExpiry || undefined });
  } catch (err) {
    if (!(err instanceof api.BadRequestError)) throw err;
    printError(`hippo auth create: ${err.message} (--ttl-days, --no-expiry).`);
    process.exit(1);
  }
  noteMintDefaults(role !== undefined, ttlFlag !== undefined || noExpiry);

  if (asJson) {
    console.log(JSON.stringify({
      keyId: result.keyId,
      plaintext: result.plaintext,
      tenantId: result.tenantId,
      label: labelFlag ?? null,
      role: result.role,
      expiresAt: result.expiresAt,
    }));
    return;
  }

  console.log(`key_id:    ${result.keyId}`);
  console.log(`plaintext: ${result.plaintext}`);
  console.log(`role:      ${result.role}`);
  console.log(`expires:   ${result.expiresAt ?? 'never'}`);
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

function cmdAuthList(hippoRoot: string, flags: CliFlags): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const includeRevoked = boolFlag(flags, 'all');
  const asJson = boolFlag(flags, 'json');

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
function keyContext(root: string, keyId: string): api.HippoDbContext {
  const hostCtx = { hippoRoot: root, tenantId: resolveTenantId({}), actor: api.adminActor('cli') };
  const keyTenant = api.authKeyTenant(hostCtx, keyId);
  if (keyTenant === undefined) {
    printError(`Unknown key_id: ${keyId}`);
    process.exit(1);
  }
  return { ...hostCtx, tenantId: keyTenant };
}

function cmdAuthRevoke(hippoRoot: string, keyId: string, flags: CliFlags): void {
  const ctx = keyContext(resolveAuthRoot(hippoRoot, flags), keyId);
  let revokedAt: string;
  try {
    revokedAt = api.authRevoke(ctx, keyId).revokedAt;
  } catch (err) {
    printError(`Error: ${errorMessage(err)}`);
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify({ keyId, revokedAt }));
    return;
  }
  console.log(`Revoked ${keyId} at ${revokedAt}`);
}

/** `hippo auth grant|ungrant <key_id> <scope>`, routed through api so the tenant, restricted-scope and audit checks live in one place. */
function cmdAuthScopeGrant(hippoRoot: string, keyId: string, scope: string, grant: boolean, flags: CliFlags): void {
  const ctx = keyContext(resolveAuthRoot(hippoRoot, flags), keyId);
  try {
    if (grant) api.authGrant(ctx, keyId, scope);
    else api.authUngrant(ctx, keyId, scope);
  } catch (err) {
    printError(`Error: ${errorMessage(err)}`);
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify({ keyId, scope, granted: grant }));
    return;
  }
  console.log(grant ? `Granted ${keyId} read access to ${scope}` : `Removed ${keyId}'s grant on ${scope}`);
}

export function cmdAuth(hippoRoot: string, args: string[], flags: CliFlags): void {
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
