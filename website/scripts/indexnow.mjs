#!/usr/bin/env node
// Post-deploy only: submits URLs to IndexNow, read from dist/sitemap-0.xml or given as arguments.
// The key is public by design, served at /<key>.txt. `--dry-run` prints the payload instead of sending it.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = 'hippo-memory.com';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const keyFile = readdirSync(join(root, 'public')).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) throw new Error('no IndexNow key file (32 hex characters + .txt) in public/');
const key = keyFile.slice(0, -4);
if (readFileSync(join(root, 'public', keyFile), 'utf8').trim() !== key) throw new Error(`${keyFile} must contain its own key`);

const given = args.filter((a) => a !== '--dry-run');
const urlList = given.length
  ? given
  : [...readFileSync(join(root, 'dist', 'sitemap-0.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const body = { host, key, keyLocation: `https://${host}/${keyFile}`, urlList };

if (dryRun) {
  console.log(JSON.stringify(body, null, 2));
} else {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  console.log(`IndexNow: HTTP ${res.status} for ${urlList.length} URLs`);
  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }
}
