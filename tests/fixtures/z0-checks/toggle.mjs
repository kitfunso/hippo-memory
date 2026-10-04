#!/usr/bin/env node
// Toy checker whose verdict follows an env var, so a test can make the run and the regrade disagree.
// The var is Z0_TOGGLE, or the one `var=<NAME>` names: "regrade" exits Z0_TOGGLE_TO (default 1; 3 gives na), anything else 0.
const named = process.argv.slice(2).find((a) => a.startsWith('var='));
const name = named ? named.slice('var='.length) : 'Z0_TOGGLE';
process.exit(process.env[name] === 'regrade' ? Number(process.env.Z0_TOGGLE_TO ?? 1) : 0);
