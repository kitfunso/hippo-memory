// SessionEnd capture, no model call: keeps whole sentences (not keyword-anchored
// fragments) so the subject and reason survive.

import type { ExtractedItem } from './capture.js';

export interface SessionTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

const FAMILIES: ReadonlyArray<{ readonly name: string; readonly score: number; readonly re: RegExp }> = [
  { name: 'error', score: 3, re: /\b(root cause(?::| (?:is|was)\b)|the (?:real )?(?:fix|cause|issue|problem|bug|workaround) (?:is|was)\b(?! (?:real|in|live|done|right|worth|not|checkable|one|running|blocked|proven|verified)\b)|workaround|gotcha|fails? (?:because|when|if|on)|breaks? (?:because|when|if|on)|silently)\b/i },
  { name: 'decision', score: 2, re: /\b(we(?:'ve| have)? decided|decided to|we(?:'re| are)? going with|we(?:'ll| will) (?:use|keep|switch|go with)|switch(?:ed)? to|chose|the plan is)\b/i },
  { name: 'rule', score: 2, re: /\b(never|always|must(?: not)?|do not|don't|only ever)\b/i },
  { name: 'preference', score: 2, re: /\b(prefer|instead of|rather than|avoid)\b/i },
];
const DEICTIC = /^(this|that|these|those|it|it's|its|they|their|them|he|she|here|there|so|then|also|and|but|or|both|each|which|same|now|next|yes|no|ok|okay|sure|done|nothing|everything|one|two|three|either|neither|what|why|how|if|when|once|after|before|while|good|great|thanks|please|just|first|second|third|finally|where)\b/i;
const NARRATION = /^(i|i'm|i've|i'll|i'd|let me|let's|my|we|we'll|we're|you|your|you're|you've)\b/i;
const USER_PREF = /^i (?:(?:don't|do not|never|always) (?:like|want|use)|prefer|hate|dislike)\b/i;
const SESSION_LOCAL = /\b(this (?:session|turn|chat|conversation|message|episode|round|run|pr|branch)|above|below|earlier|just now|right now|my last|your last|last message|option [a-d1-4]\b|step \d|the first one|the second one|your call|your decision)\b/i;
const IMPERATIVE_NOW = /^(run|go|do|make|try|check|fix|add|remove|delete|update|push|commit|merge|ship|continue|proceed|stop|wait|use|write|read|open|show|tell|give|send|look|see|keep|start|test|work|raise)\b/i;
const LABEL_LEAD = /^(brief|where|note|update|status|result|summary|next|done|problem|answer|cost if|risk|verdict|fixed)\b[^:]{0,40}:/i;
const TRANSIENT = /\b(yet|still|now|currently|so far|at the moment|today|tonight|tomorrow|this morning)\b/i;

const MIN_SCORE = 3;

function sentences(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (let line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    line = line.trim();
    if (!line || /^(\||#|>|<|\$ |[-=*_]{3,}$)/.test(line)) continue;
    line = line.replace(/^([-*+]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').trim();
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)) out.push(s.trim());
  }
  return out;
}

interface Candidate {
  readonly content: string;
  readonly category: string;
  readonly score: number;
}

function candidate(sent: string, next: string | undefined, who: 'user' | 'assistant'): Candidate | null {
  if (sent.length < 40 || sent.length > 300) return null;
  if (/\?$/.test(sent) || /:$/.test(sent)) return null;
  if ((sent.match(/[|{}<>=;]/g) ?? []).length > 3) return null;
  if (!/^[A-Z`(\d]/.test(sent)) return null;
  if (who === 'assistant' && /\bI(?:'m|'ll|'ve|'d)?\b/.test(sent)) return null;
  if (LABEL_LEAD.test(sent)) return null;
  if (DEICTIC.test(sent)) return null;
  const userPref = who === 'user' && USER_PREF.test(sent);
  if (NARRATION.test(sent) && !userPref) return null;
  if (who === 'user' && IMPERATIVE_NOW.test(sent) && !/\b(never|always)\b/i.test(sent)) return null;
  if (SESSION_LOCAL.test(sent) || TRANSIENT.test(sent)) return null;
  const fam = FAMILIES.find((f) => f.re.test(sent));
  if (!fam && !userPref) return null;
  let content = sent;
  let score = fam ? fam.score : 2;
  if (/\b(because|since|so that|otherwise|which means)\b/i.test(sent)) score += 1;
  else if (next && /^(because|that's because|the reason|this is because|otherwise)\b/i.test(next) && (sent + ' ' + next).length <= 400) { content = sent + ' ' + next; score += 1; }
  if (who === 'user') score += 1;
  return { content: content.replace(/[\s,;:]+$/, ''), category: fam ? fam.name : 'preference', score };
}

export function extractSessionMemories(turns: readonly SessionTurn[], cap = 3): ExtractedItem[] {
  const all: (Candidate & { order: number })[] = [];
  const seen = new Set<string>();
  turns.forEach((turn, ti) => {
    const ss = sentences(turn.text);
    ss.forEach((s, i) => {
      const c = candidate(s, ss[i + 1], turn.role);
      if (!c) return;
      const k = c.content.toLowerCase().replace(/\W+/g, ' ').trim();
      if (seen.has(k)) return;
      seen.add(k);
      all.push({ ...c, order: ti * 1000 + i });
    });
  });
  return all
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || b.order - a.order)
    .slice(0, cap)
    .map((c) => ({ content: c.content, category: c.category, tags: [c.category, 'captured'] }));
}
