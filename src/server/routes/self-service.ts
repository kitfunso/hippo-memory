// SSO sign-in routes: the public connect info a client starts from, and the member key an SSO caller mints for itself.
import type { ServerResponse } from 'node:http';
import { authCreateSelf } from '../../api.js';
import { HttpError, readBody, sendJson } from '../../http-util.js';
import { isJsonString } from '../../json.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest, SelfServiceKeysOpts, ServeOpts } from '../types.js';
import { MINT_BODY_MAX_BYTES, parseJsonObjectText } from '../validation.js';

/** Fails boot on a config that would mint keys that never expire, or a cap that leaves a subject no key. */
export function assertSelfServiceKeys(self: SelfServiceKeysOpts | undefined): void {
  if (!self) return;
  if (!Number.isFinite(self.ttlDays) || self.ttlDays <= 0) {
    throw new Error(`selfServiceKeys.ttlDays must be a positive number of days, got ${String(self.ttlDays)}`);
  }
  if (!Number.isInteger(self.perSubject) || self.perSubject < 1) {
    throw new Error(`selfServiceKeys.perSubject must be a whole number of at least 1, got ${String(self.perSubject)}`);
  }
}

// GET /v1/auth/connect: public, so a client with no key yet can find where to sign in; 404 when the server offers no SSO sign-in.
export function handleConnectInfo(res: ServerResponse, opts: ServeOpts): void {
  const info = opts.connectInfo;
  if (!info) throw new HttpError(404, 'not found');
  // Only the four named fields go out, so a secret passed in by mistake never does.
  const { issuer, clientId, scopes, redirectUris } = info;
  sendJson(res, 200, { issuer, clientId, scopes, redirectUris });
}

// POST /v1/auth/keys/self: an SSO caller mints its own member key, owned by its subject and expiring after ttlDays.
export async function handleCreateSelfAuthKey({ req, res, opts }: RouteRequest): Promise<void> {
  const self = opts.selfServiceKeys;
  if (!self) throw new HttpError(404, 'not found');
  // Body first, so the resolver's check (and any SCIM gate in it) runs right before the mint with no wait between.
  const raw = await readBody(req, MINT_BODY_MAX_BYTES);
  const ctx = await buildContextWithAuth(req, opts);
  const body = parseJsonObjectText(raw);
  const extra = Object.keys(body).find((k) => k !== 'label');
  if (extra !== undefined) throw new HttpError(400, `unknown field ${JSON.stringify(extra)}: this route accepts only label`);
  const label = body['label'];
  if (label !== undefined && !isJsonString(label)) throw new HttpError(400, 'label must be a string');
  sendJson(res, 200, authCreateSelf(ctx, { label, ttlDays: self.ttlDays, perSubject: self.perSubject }));
}
