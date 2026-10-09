// `hippo auth`: create, list, revoke and scope API keys.

import { listApiKeys, type ApiKeyListItem } from '../store/auth.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { type CliFlags, resolveAuthRoot, boolFlag, stringFlag } from './shared.js';
import { errorMessage } from '../log.js';

// ---------------------------------------------------------------------------
// Auth subcommands
// ---------------------------------------------------------------------------

function cmdAuthCreate(hippoRoot: string, flags: CliFlags): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantFlag = stringFlag(flags, 'tenant');
  const labelFlag = stringFlag(flags, 'label');
  const asJson = boolFlag(flags, 'json');

  // Accepts 'admin' | 'member' only; anything else exits 1 so a typo doesn't silently default to admin.
  const roleFlag = stringFlag(flags, 'role');
  let role: 'admin' | 'member' = 'admin';
  if (roleFlag !== undefined) {
    if (roleFlag !== 'admin' && roleFlag !== 'member') {
      printError(`Invalid --role value: '${roleFlag}'. Use 'admin' or 'member'.`);
      process.exit(1);
    }
    role = roleFlag;
  } else {
    // The default is the widest key hippo mints, so the operator is told at the moment of choosing. Stderr keeps --json output clean.
    printError('hippo auth create: no --role given, so this is an admin key, and it never expires. Pass --role member for a narrower key; revoke either with `hippo auth revoke <key_id>`.');
  }

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

function cmdAuthList(hippoRoot: string, flags: CliFlags): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const includeRevoked = boolFlag(flags, 'all');
  const asJson = boolFlag(flags, 'json');

  const items = listApiKeys(root, { active: !includeRevoked });

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
