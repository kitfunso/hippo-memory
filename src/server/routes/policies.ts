// /v1/policies routes.
import { closePolicy, loadPolicies, loadPoliciesAsOf, loadPolicyById, savePolicy, VALID_POLICY_STATES } from '../../policies.js';
import { HttpError, type JsonValue, sendJson } from '../../http-util.js';
import { buildContextWithAuth } from '../auth.js';
import type { RouteRequest } from '../types.js';
import { isJsonString, isSetMember, parseJsonBody, parseListLimit } from '../validation.js';

// HTTP-boundary check for an optional policy date field (validFrom/validTo).
// Type + length only; savePolicy/loadPoliciesAsOf normalize + format-validate the
// value (an unparseable date throws there -> mapped to 400). 64-char cap bounds a
// junk string before it reaches the Date parser.
function optionalDateField(raw: JsonValue | undefined, label: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isJsonString(raw)) {
    throw new HttpError(400, `${label} must be a string`);
  }
  if (raw.length > 64) {
    throw new HttpError(400, `${label} exceeds 64-character cap`);
  }
  return raw;
}

// ── policies (E2 first-class object, bi-temporal-first) ──
//
// 6 routes: POST /v1/policies (new; processName-style body policyName +
// policyText + validFrom? + validTo?), GET /v1/policies (list, status filter),
// GET /v1/policies/asof (date + optional name; the bi-temporal as-of query;
// placed BEFORE the /:id GET so the literal 'asof' is matched first), GET
// /v1/policies/:id, POST /v1/policies/:id/supersede, POST /v1/policies/:id/close.
// Date inputs are normalized + range-validated in the store; an invalid/inverted
// date throws -> 400. DoS caps: policyName/policyText/changeSummary 4096.
export async function handleCreatePolicy({ req, res, opts }: RouteRequest): Promise<void> {
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const policyName = body['policyName'];
  if (!isJsonString(policyName) || policyName.trim().length === 0) {
    throw new HttpError(400, 'policyName is required (non-empty string)');
  }
  if (policyName.length > 4096) {
    throw new HttpError(400, 'policyName exceeds 4096-character cap');
  }
  const policyText = body['policyText'];
  if (!isJsonString(policyText) || policyText.trim().length === 0) {
    throw new HttpError(400, 'policyText is required (non-empty string)');
  }
  if (policyText.length > 4096) {
    throw new HttpError(400, 'policyText exceeds 4096-character cap');
  }
  const validFrom = optionalDateField(body['validFrom'], 'validFrom');
  const validTo = optionalDateField(body['validTo'], 'validTo');
  const policy = savePolicy(opts.hippoRoot, ctx.tenantId, {
    policyName,
    policyText,
    validFrom,
    validTo,
  }, ctx.actor.subject);
  sendJson(res, 201, { policy });
  return;
}

export async function handleListPolicies({ req, res, opts, query }: RouteRequest): Promise<void> {
  const status = query.get('status') ?? 'all';
  const limit = parseListLimit(query.get('limit'));
  const ctx = await buildContextWithAuth(req, opts);
  let policies;
  if (status === 'all') {
    policies = loadPolicies(opts.hippoRoot, ctx.tenantId, { limit });
  } else {
    if (!isSetMember(VALID_POLICY_STATES, status)) {
      throw new HttpError(400, `status must be one of: active | superseded | closed | all (got "${status}")`);
    }
    policies = loadPolicies(opts.hippoRoot, ctx.tenantId, {
      status,
      limit,
    });
  }
  sendJson(res, 200, { policies });
  return;
}

// The as-of query: must precede the /:id GET (literal 'asof' is non-numeric so
// the /(\d+)/ route would not match it, but order it first for clarity).
export async function handlePoliciesAsOf({ req, res, opts, query }: RouteRequest): Promise<void> {
  const date = query.get('date');
  if (date === null || date.length === 0) {
    throw new HttpError(400, 'date is required (ISO-8601 valid-time)');
  }
  const name = query.get('name') ?? undefined;
  const ctx = await buildContextWithAuth(req, opts);
  const policies = loadPoliciesAsOf(opts.hippoRoot, ctx.tenantId, date, { name });
  sendJson(res, 200, { policies });
  return;
}

export async function handleSupersedePolicy({ req, res, opts }: RouteRequest, policySupersedeMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(policySupersedeMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const body = await parseJsonBody(req, ctx);
  const policyText = body['policyText'];
  if (!isJsonString(policyText) || policyText.trim().length === 0) {
    throw new HttpError(400, 'policyText is required (non-empty string)');
  }
  if (policyText.length > 4096) {
    throw new HttpError(400, 'policyText exceeds 4096-character cap');
  }
  const validFrom = optionalDateField(body['validFrom'], 'validFrom');
  const validTo = optionalDateField(body['validTo'], 'validTo');
  const changeRaw = body['changeSummary'];
  let changeSummary: string | undefined;
  if (changeRaw !== undefined && changeRaw !== null) {
    if (!isJsonString(changeRaw)) {
      throw new HttpError(400, 'changeSummary must be a string');
    }
    if (changeRaw.length > 4096) {
      throw new HttpError(400, 'changeSummary exceeds 4096-character cap');
    }
    changeSummary = changeRaw;
  }
  const existing = loadPolicyById(opts.hippoRoot, ctx.tenantId, id);
  if (!existing) {
    throw new HttpError(404, `policy ${id} not found`);
  }
  const policy = savePolicy(opts.hippoRoot, ctx.tenantId, {
    policyName: existing.policyName,
    policyText,
    validFrom,
    validTo,
    changeSummary,
    supersedesPolicyId: id,
  }, ctx.actor.subject);
  sendJson(res, 200, { policy });
  return;
}

export async function handleClosePolicy({ req, res, opts }: RouteRequest, policyCloseMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(policyCloseMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const policy = closePolicy(opts.hippoRoot, ctx.tenantId, id, ctx.actor.subject);
  sendJson(res, 200, { policy });
  return;
}

export async function handleGetPolicy({ req, res, opts }: RouteRequest, policyByIdMatch: RegExpMatchArray): Promise<void> {
  const id = parseInt(policyByIdMatch[1], 10);
  const ctx = await buildContextWithAuth(req, opts);
  const policy = loadPolicyById(opts.hippoRoot, ctx.tenantId, id);
  if (!policy) {
    throw new HttpError(404, `policy ${id} not found`);
  }
  sendJson(res, 200, { policy });
  return;
}
