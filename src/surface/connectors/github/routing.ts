import type { JsonValue } from '../../../base/util/json.js';
import type { GitHubWebhookEnvelope } from './types.js';

export interface DlqRouting {
  installationId: string | null;
  repoFullName: string | null;
}

function isInstallationId(value: JsonValue | undefined): value is string | number {
  return (
    (typeof value === 'string' && value !== '') ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isRepoFullName(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value !== '';
}

export function routingOf(body: GitHubWebhookEnvelope): DlqRouting {
  const installation = body.installation?.id;
  const repository = body.repository?.full_name;
  return {
    installationId: isInstallationId(installation) ? String(installation) : null,
    repoFullName: isRepoFullName(repository) ? repository : null,
  };
}
