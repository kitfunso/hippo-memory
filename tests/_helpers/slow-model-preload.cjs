// Preloaded into a spawned CLI: answers the Anthropic Messages API itself and holds every call while SLOW_MODEL_DIR/hold exists, so a test decides how long a sleep stays inside the model.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.SLOW_MODEL_DIR;
const hold = path.join(dir, 'hold');
// A test that dies without removing the hold file must not leave its sleeps stuck for good.
const HOLD_LIMIT_MS = 25_000;
let calls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.anthropic.com')) return realFetch(url, init);
  const n = calls++;
  const prompt = JSON.parse(init.body).messages[0].content;
  const extracting = prompt.includes('extracting factual statements');
  fs.writeFileSync(path.join(dir, `entered-${process.pid}-${n}-${extracting ? 'extract' : 'other'}`), '');
  const giveUp = Date.now() + HOLD_LIMIT_MS;
  while (fs.existsSync(hold) && Date.now() < giveUp) await new Promise((resolve) => setTimeout(resolve, 20));
  let text;
  if (extracting) {
    const source = (prompt.split('Input text:\n')[1] || '').trim().replace(/\s+/g, ' ').slice(0, 70);
    // The wording names the call, so two sleeps never word one fact alike and the dedupe pass cannot merge their copies.
    text = JSON.stringify([
      {
        content: `Alice recorded in call ${n} of process ${process.pid} that ${source}.`,
        tags: ['topic:sleep-claim'],
        valence: 'neutral',
      },
    ]);
  } else {
    text = `Summary of the related facts: ${prompt.slice(-120).replace(/\s+/g, ' ')}`;
  }
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
};
