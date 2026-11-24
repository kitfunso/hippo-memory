import * as api from '../../api/index.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { type CliFlags, boolFlag, stringFlag, type CommandContext } from './flag-values.js';
import { resolveAuthRoot } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { fail } from './exit.js';
import type { ApiKeyListItem } from '../../base/ports/store/keys.js';

function roleFlagOrExit(flags: CliFlags): 'admin' | 'member' | undefined {
  const roleFlag = stringFlag(flags, 'role');
  if (roleFlag !== undefined && roleFlag !== 'admin' && roleFlag !== 'member') {
    fail(`Invalid --role value: '${roleFlag}'. Use 'admin' or 'member'.`);
  }
  return roleFlag;
}

function noteMintDefaults(roleGiven: boolean, expiryGiven: boolean): void {
  const notes: string[] = [];
  if (!roleGiven) {
    notes.push('no --role given, so this is a member key (pass --role admin for an admin key)');
  }
  if (!expiryGiven) notes.push('no --ttl-days or --no-expiry given, so it expires in 90 days');
  if (notes.length > 0) printError(`hippo auth create: ${notes.join('; ')}.`);
}

async function createApiKey(
  hippoRoot: string,
  defaultTenantId: string,
  flags: CliFlags,
): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantFlag = stringFlag(flags, 'tenant');
  const labelFlag = stringFlag(flags, 'label');
  const asJson = boolFlag(flags, 'json');
  const role = roleFlagOrExit(flags);
  const ttlFlag = stringFlag(flags, 'ttl-days');
  const ttlDays = ttlFlag === undefined ? undefined : Number(ttlFlag);
  const noExpiry = boolFlag(flags, 'no-expiry');

  const ctx = cliApiContext(root, tenantFlag ?? defaultTenantId);
  const result = await mintApiKey(ctx, {
    label: labelFlag,
    role,
    ttlDays,
    noExpiry: noExpiry || undefined,
  });
  noteMintDefaults(role !== undefined, ttlFlag !== undefined || noExpiry);
  printMintedKey(result, labelFlag, asJson);
}

async function mintApiKey(
  ctx: api.Context,
  opts: api.AuthCreateOptions,
): Promise<api.AuthCreateResult> {
  try {
    return await api.authCreate(ctx, opts);
  } catch (err) {
    if (!(err instanceof api.BadRequestError)) throw err;
    fail(`hippo auth create: ${err.message} (--ttl-days, --no-expiry).`);
  }
}

function printMintedKey(
  result: api.AuthCreateResult,
  labelFlag: string | undefined,
  asJson: boolean,
): void {
  if (asJson) {
    console.log(
      JSON.stringify({
        keyId: result.keyId,
        plaintext: result.plaintext,
        tenantId: result.tenantId,
        label: labelFlag ?? null,
        role: result.role,
        expiresAt: result.expiresAt,
      }),
    );
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
  const scopes = item.scopes.length > 0 ? item.scopes.join(',') : '-';
  return `${item.keyId}  ${item.tenantId}  ${item.role}  ${label}  ${created}  ${expires}  ${revoked}  ${scopes}`;
}

async function listApiKeys(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const includeRevoked = boolFlag(flags, 'all');
  const asJson = boolFlag(flags, 'json');

  const items = await api.authListAllTenants(cliApiContext(root, tenantId), !includeRevoked);

  if (asJson) {
    console.log(JSON.stringify(items));
    return;
  }

  if (items.length === 0) {
    console.log(
      includeRevoked
        ? 'No API keys.'
        : 'No active API keys. (Use --all to include revoked and expired.)',
    );
    return;
  }

  console.log('key_id  tenant  role  label  created  expires  revoked  scopes');
  for (const item of items) {
    console.log(formatKeyRow(item));
  }
}

interface KeyContextOptions {
  readonly root: string;
  readonly tenantId: string;
  readonly keyId: string;
}

async function keyContext({ root, tenantId, keyId }: KeyContextOptions): Promise<api.Context> {
  const hostCtx = cliApiContext(root, tenantId);
  const keyTenant = await api.authKeyTenant(hostCtx, keyId);
  if (keyTenant === undefined) {
    fail(`Unknown key_id: ${keyId}`);
  }
  return { ...hostCtx, tenantId: keyTenant };
}

interface RevokeApiKeyOptions {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly keyId: string;
  readonly flags: CliFlags;
}

async function revokeApiKey({
  hippoRoot,
  tenantId,
  keyId,
  flags,
}: RevokeApiKeyOptions): Promise<void> {
  const ctx = await keyContext({ root: resolveAuthRoot(hippoRoot, flags), tenantId, keyId });
  let revokedAt: string;
  try {
    revokedAt = (await api.authRevoke(ctx, keyId)).revokedAt;
  } catch (err) {
    fail(`Error: ${errorMessage(err)}`);
  }
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ keyId, revokedAt }));
    return;
  }
  console.log(`Revoked ${keyId} at ${revokedAt}`);
}

interface AuthScopeGrantOptions {
  hippoRoot: string;
  tenantId: string;
  keyId: string;
  scope: string;
  grant: boolean;
  flags: CliFlags;
}

async function changeKeyScope(options: AuthScopeGrantOptions): Promise<void> {
  const { hippoRoot, tenantId, keyId, scope, grant, flags } = options;
  const ctx = await keyContext({ root: resolveAuthRoot(hippoRoot, flags), tenantId, keyId });
  try {
    if (grant) await api.authGrant(ctx, keyId, scope);
    else await api.authUngrant(ctx, keyId, scope);
  } catch (err) {
    fail(`Error: ${errorMessage(err)}`);
  }
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ keyId, scope, granted: grant }));
    return;
  }
  console.log(
    grant ? `Granted ${keyId} read access to ${scope}` : `Removed ${keyId}'s grant on ${scope}`,
  );
}

export async function handleAuth({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const sub = args[0];
  if (!sub) {
    fail('Usage: hippo auth <create|list|revoke|grant|ungrant> [options]');
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'create':
      await createApiKey(hippoRoot, tenantId, flags);
      return;
    case 'list':
      await listApiKeys(hippoRoot, tenantId, flags);
      return;
    case 'revoke': {
      const keyId = subArgs[0];
      if (!keyId) {
        fail('Usage: hippo auth revoke <key_id>');
      }
      await revokeApiKey({ hippoRoot, tenantId, keyId, flags });
      return;
    }
    case 'grant':
    case 'ungrant': {
      const [keyId, scope] = subArgs;
      if (!keyId || !scope) {
        fail(`Usage: hippo auth ${sub} <key_id> <scope>`);
      }
      await changeKeyScope({ hippoRoot, tenantId, keyId, scope, grant: sub === 'grant', flags });
      return;
    }
    default:
      fail(`Unknown auth subcommand: ${sub}. Expected: create | list | revoke | grant | ungrant.`);
  }
}
