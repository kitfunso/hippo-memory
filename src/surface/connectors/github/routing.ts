import type { GitHubWebhookEnvelope } from './types.js';

export interface DlqRouting {
  installationId: string | null;
  repoFullName: string | null;
}

export function routingOf(body: GitHubWebhookEnvelope): DlqRouting {
  return {
    installationId: body.installation?.id != null ? String(body.installation.id) : null,
    repoFullName: body.repository?.full_name ?? null,
  };
}
