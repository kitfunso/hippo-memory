// Failure signatures and block-to-memory mapping for the Z1 replay, kept as SI0 wrote them.

// ---------------------------------------------------------------------------
// SI0 machinery, copied verbatim (docs/plans/2026-09-24-si0-automatic-outcomes.md)
// ---------------------------------------------------------------------------

export const sig = (t) => t.toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const ROUTINE = [
  /user (?:doesn't|does not) want|denied by (?:the )?user|user (?:rejected|declined|denied)|permission (?:denied|to use)|was blocked by (?:a )?hook/i,
  /\bno (?:matches|files|results) found\b/i,
];
const QUIET = /^\s*(?:grep|rg|egrep|fgrep|find|test|\[|diff|cmp|git diff|git grep)\b/;
export const routine = (cmd, err) =>
  err.trim().length < 12 || ROUTINE.some((r) => r.test(err)) || (QUIET.test(cmd) && /exit code 1\b/i.test(err));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const BUL =
  /^- \*\*\[[^\]]+\](?: ⚠️)? (?:Previously observed \(\d{4}-\d{2}-\d{2}\): |Consider checking: )?(?:\[global\] )?([\s\S]*)\*\*(?: \[[^\]]*\])?(?: \(\d+%\))?$/;

export function buildIndices(allEntries) {
  const byId = new Map();
  const byContent = new Map();
  for (const e of allEntries) {
    byId.set(e.id, e);
    const k = norm(e.content);
    if (!byContent.has(k)) byContent.set(k, new Set());
    byContent.get(k).add(e.id);
  }
  return { byId, byContent };
}

export function makeMapBlock(byId, byContent) {
  const contents = [...byContent.keys()];
  return function mapBlock(text) {
    const ids = new Set();
    if (!text.includes('## Project Memory')) return ids;
    const sec = text.slice(text.indexOf('## Project Memory'));
    const parts = sec.split(/\n(?=- \*\*\[)/).slice(1);
    for (let part of parts) {
      part = part.split(/\n\n/)[0];
      const m = BUL.exec(part.trim());
      if (!m) continue;
      let c = norm(m[1]);
      let hit = byContent.get(c);
      if (!hit && c.endsWith(' [truncated]')) {
        const pre = c.replace(/ \[truncated\]$/, '');
        const cands = contents.filter((k) => k.startsWith(pre));
        hit = cands.length === 1 ? byContent.get(cands[0]) : cands.length > 1 ? new Set(['a', 'b']) : undefined;
      }
      if (!hit || hit.size !== 1) continue;
      ids.add([...hit][0]);
    }
    return ids;
  };
}

export function idsFromRecall(byId, txt) {
  return new Set(
    [...txt.matchAll(/(?:^|\n)--- (mem_[0-9a-f]{12})|"id":"(mem_[0-9a-f]{12})"/g)]
      .map((m) => m[1] || m[2])
      .filter((id) => byId.has(id)),
  );
}
