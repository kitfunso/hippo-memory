import { isStringValue } from '../../base/session/capture-contract.js';
import type { SessionTurn } from './transcript.js';

export interface ChatLine {
  type?: unknown;
  role?: unknown;
  content?: unknown;
}

export function chatLineTurn(entry: ChatLine): SessionTurn | null {
  if ('type' in entry) return null;
  const { role, content } = entry;
  if (role !== 'user' && role !== 'assistant') return null;
  if (!isStringValue(content)) return null;
  const text = content.trim();
  return text ? { role, text } : null;
}
