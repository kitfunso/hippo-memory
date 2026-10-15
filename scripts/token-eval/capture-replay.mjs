// Usage: node scripts/token-eval/capture-replay.mjs <tasks.json>... (after `npm run build`; exit 1 if any lesson goes unpinned)
// Replays every Z0 teach message through capture and counts the lessons it would pin; prints counts and lesson ids only.
import * as fs from 'node:fs';
import { extractFromTexts, isStandingRule } from '../../dist/capture/extract.js';
import { teachMessage } from './lessons.mjs';

const FORMS = ['correction', 'confirmation'];

/** Whether capture keeps an item holding the lesson's key phrase, and whether it would pin it. */
function replayLesson(lesson, form) {
  const items = extractFromTexts([teachMessage(lesson, form)], 1).filter((i) => i.content.includes(lesson.keyPhrase));
  const pinned = items.some((i) => i.fromUser === true && i.category === 'rule' && isStandingRule(i.content));
  return { captured: items.length > 0, pinned };
}

function replayFile(file) {
  const lessons = JSON.parse(fs.readFileSync(file, 'utf8')).families.flatMap((f) => f.lessons);
  return FORMS.map((form) => {
    const results = lessons.map((lesson) => ({ id: lesson.id, ...replayLesson(lesson, form) }));
    return {
      file, form, lessons: results.length,
      captured: results.filter((r) => r.captured).length,
      pinned: results.filter((r) => r.pinned).length,
      unpinned: results.filter((r) => !r.pinned).map((r) => r.id),
    };
  });
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/token-eval/capture-replay.mjs <tasks.json>...');
  process.exit(2);
}
const rows = files.flatMap(replayFile);
for (const r of rows) {
  console.log(`${r.file} ${r.form}: lessons ${r.lessons}, captured ${r.captured}, pinned ${r.pinned}, unpinned [${r.unpinned.join(', ')}]`);
}
const total = rows.reduce((n, r) => n + r.lessons, 0);
const pinned = rows.reduce((n, r) => n + r.pinned, 0);
console.log(`total: ${pinned} of ${total} pinned`);
process.exitCode = pinned === total ? 0 : 1;
