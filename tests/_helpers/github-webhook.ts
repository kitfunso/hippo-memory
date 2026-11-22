// A signed GitHub webhook request: the secret, the signature and the headers every webhook test sends.
import { createHmac } from 'node:crypto';

export const SECRET = 'github-webhook-secret';

export function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function postWebhook(port: number, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/connectors/github/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

export function defaultHeaders(body: string, eventName: string, deliveryId: string) {
  return {
    'x-hub-signature-256': sign(body),
    'x-github-event': eventName,
    'x-github-delivery': deliveryId,
  };
}
