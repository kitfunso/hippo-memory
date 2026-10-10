// The Claude Code transcript contract the Z10 reader joins on: which lines are prompts, which hooks fired under them, and which turn row owns which prompt.

const TAGS = [
  'task-notification', 'command-name', 'local-command-stdout', 'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr',
];

// String(v) === v holds only for a string primitive, which a JSON line's text always is.
export const isText = (v) => String(v) === v;

function promptBody(content) {
  if (isText(content)) return { text: content, image: false };
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((b) => b instanceof Object);
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  const texts = blocks.filter((b) => b.type === 'text' && isText(b.text));
  if (texts.length === 0) return null;
  return { text: texts.map((b) => b.text).join('\n'), image: blocks.some((b) => b.type === 'image') };
}

function kindOf(text) {
  const tag = /^\s*<([a-z-]+)/.exec(text)?.[1];
  return TAGS.includes(tag) ? tag : 'prompt';
}

function hookText(content) {
  return Array.isArray(content) ? content.join('\n') : String(content ?? '');
}

/** Candidate prompts with the UserPromptSubmit attachments under each, and the compaction lines, by line position. */
export function parseTranscript(text) {
  const candidates = [];
  const compactions = [];
  const skipped = [];
  text.split('\n').forEach((raw, pos) => {
    if (raw.trim() === '') return;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      skipped.push(pos);
      return;
    }
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      compactions.push({ pos });
    } else if (line.type === 'user' && !line.isMeta && !line.isCompactSummary) {
      const body = promptBody(line.message?.content);
      if (body) candidates.push({ index: candidates.length, pos, kind: kindOf(body.text), image: body.image, text: body.text, attachments: [], fired: false });
    } else if (line.type === 'attachment' && line.attachment?.type === 'hook_additional_context' && line.attachment.hookEvent === 'UserPromptSubmit') {
      const owner = candidates[candidates.length - 1];
      if (owner) {
        owner.attachments.push(hookText(line.attachment.content));
        owner.fired = true;
      }
    }
  });
  return { candidates, compactions, skipped };
}

const positional = (c) => c.kind === 'prompt' || c.kind === 'task-notification';

/** Pairs rows `{id, prompt_hash, emitted}` in id order with candidates; `hash` is the ledger's blockHash, passed in so this file imports nothing from dist. */
export function pairTurns(parsed, rows, hash) {
  const cands = parsed.candidates;
  const taken = new Set();
  const pairs = new Map();
  const bind = (row, cand, by) => {
    pairs.set(row.id, { cand, by });
    taken.add(cand);
  };
  const before = (i) => {
    for (let k = i - 1; k >= 0; k--) if (pairs.has(rows[k].id)) return pairs.get(rows[k].id).cand;
    return -1;
  };
  const after = (i) => {
    for (let k = i + 1; k < rows.length; k++) if (pairs.has(rows[k].id)) return pairs.get(rows[k].id).cand;
    return cands.length;
  };

  rows.forEach((row, i) => {
    if (row.prompt_hash === null) return;
    for (let c = before(i) + 1; c < cands.length; c++) {
      if (positional(cands[c]) && !taken.has(c) && hash(cands[c].text) === row.prompt_hash) {
        bind(row, c, 'prompt');
        return;
      }
    }
  });

  rows.forEach((row, i) => {
    if (pairs.has(row.id) || row.emitted.length === 0) return;
    for (let c = before(i) + 1; c < after(i); c++) {
      if (!taken.has(c) && cands[c].fired && cands[c].attachments.some((a) => row.emitted.includes(hash(a)))) {
        bind(row, c, 'attachment');
        return;
      }
    }
  });

  for (let i = 0; i < rows.length;) {
    if (pairs.has(rows[i].id)) {
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !pairs.has(rows[j].id)) j++;
    const free = [];
    for (let c = before(i) + 1; c < after(j - 1); c++) if (positional(cands[c]) && !taken.has(c)) free.push(c);
    if (free.length === j - i) for (let k = 0; k < free.length; k++) bind(rows[i + k], free[k], 'position');
    i = j;
  }

  const fired = cands.filter((c) => c.fired);
  const gaps = fired.filter((c) => !taken.has(c.index)).map((c) => ({ cand: c.index, ordinal: fired.indexOf(c) }));
  return { pairs, gaps };
}
