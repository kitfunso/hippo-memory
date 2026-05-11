#!/usr/bin/env node
/**
 * Fetch the `Xenova/all-MiniLM-L6-v2` embedding model from the Qdrant
 * fastembed Google Cloud Storage bucket and lay it out in the
 * `@xenova/transformers` local-cache directory structure.
 *
 * Why this script exists: in egress-restricted environments (e.g. Claude
 * Code Cloud sandboxes) `huggingface.co` is not allowlisted, so the default
 * @xenova/transformers download path fails. Qdrant publishes the same model
 * files on storage.googleapis.com, which is on common allowlists.
 *
 * Layout produced (matches @xenova/transformers' local-model expectations):
 *
 *   <dest>/Xenova/all-MiniLM-L6-v2/
 *     config.json
 *     tokenizer.json
 *     tokenizer_config.json
 *     special_tokens_map.json
 *     vocab.txt
 *     onnx/
 *       model.onnx          (FP32, ~86 MB — Qdrant ships only this variant)
 *
 * Pair with the HIPPO_MODEL_CACHE env var (consumed by src/embeddings.ts):
 *
 *   HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
 *     node bin/hippo.js embed --store-dir hippo_store2
 *
 * The Qdrant tarball ships `model.onnx` (FP32) only, not `model_quantized.onnx`.
 * src/embeddings.ts must therefore request `{ quantized: false }` when this
 * cache is in use. (Functionally equivalent for similarity search; FP32 is
 * slower per inference but trivial at our 940-memory scale.)
 *
 * Idempotent: skips download + extraction when the target tree already
 * contains a non-empty model.onnx. Run with `--force` to re-fetch.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';

const TARBALL_URL = 'https://storage.googleapis.com/qdrant-fastembed/sentence-transformers-all-MiniLM-L6-v2.tar.gz';
// Base64 MD5 published by GCS in `x-goog-hash`. Verify after download.
const EXPECTED_MD5_BASE64 = 'ES1rh090kuh/nhAyKdCO0A==';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const FILES_KEPT = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
  // model.onnx is handled separately (moved into ./onnx/)
];

function parseArgs(args) {
  const out = { dest: null, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dest') out.dest = args[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/fetch_embedding_model.mjs --dest <DIR> [--force]');
      exit(0);
    }
  }
  if (!out.dest) {
    out.dest = process.env.HIPPO_MODEL_CACHE
      || resolve('benchmarks/longmemeval/data/model-cache');
  }
  return out;
}

async function downloadTo(url, destFile) {
  const tmp = destFile + '.part';
  mkdirSync(dirname(destFile), { recursive: true });
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`download failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  await pipeline(resp.body, createWriteStream(tmp));
  renameSync(tmp, destFile);
}

function md5Base64(filePath) {
  const buf = readFileSync(filePath);
  return createHash('md5').update(buf).digest('base64');
}

function extractTarball(tarPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const res = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    throw new Error(`tar extraction failed (exit ${res.status}): ${res.stderr?.toString() || ''}`);
  }
}

function arrangeXenovaLayout(extractedRoot, targetDir) {
  // Qdrant ships files inside `fast-all-MiniLM-L6-v2/`.
  const src = join(extractedRoot, 'fast-all-MiniLM-L6-v2');
  if (!existsSync(src)) {
    throw new Error(`expected directory not found after extraction: ${src}`);
  }

  mkdirSync(join(targetDir, 'onnx'), { recursive: true });

  for (const name of FILES_KEPT) {
    const srcPath = join(src, name);
    if (!existsSync(srcPath)) {
      throw new Error(`missing required file in tarball: ${name}`);
    }
    writeFileSync(join(targetDir, name), readFileSync(srcPath));
  }

  const onnxSrc = join(src, 'model.onnx');
  if (!existsSync(onnxSrc)) {
    throw new Error('missing model.onnx in tarball');
  }
  writeFileSync(join(targetDir, 'onnx', 'model.onnx'), readFileSync(onnxSrc));
}

async function main() {
  const { dest, force } = parseArgs(argv.slice(2));
  const modelDir = join(resolve(dest), MODEL_ID);
  const onnxPath = join(modelDir, 'onnx', 'model.onnx');

  if (!force && existsSync(onnxPath) && statSync(onnxPath).size > 1_000_000) {
    console.log(`[fetch_embedding_model] already present: ${onnxPath}`);
    return;
  }

  console.log(`[fetch_embedding_model] dest: ${dest}`);
  console.log(`[fetch_embedding_model] downloading from ${TARBALL_URL} ...`);
  const tmpRoot = join(resolve(dest), '.fetch-tmp');
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });

  const tarPath = join(tmpRoot, 'minilm.tar.gz');
  const t0 = Date.now();
  await downloadTo(TARBALL_URL, tarPath);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMb = (statSync(tarPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[fetch_embedding_model] downloaded ${sizeMb} MB in ${dt}s`);

  const md5 = md5Base64(tarPath);
  if (md5 !== EXPECTED_MD5_BASE64) {
    throw new Error(`MD5 mismatch: got ${md5}, expected ${EXPECTED_MD5_BASE64}`);
  }
  console.log(`[fetch_embedding_model] MD5 verified: ${md5}`);

  const extractDir = join(tmpRoot, 'extract');
  extractTarball(tarPath, extractDir);

  // Stage to a fresh target then move into place atomically.
  const stagingDir = join(tmpRoot, 'staged');
  arrangeXenovaLayout(extractDir, stagingDir);

  rmSync(modelDir, { recursive: true, force: true });
  mkdirSync(dirname(modelDir), { recursive: true });
  renameSync(stagingDir, modelDir);
  rmSync(tmpRoot, { recursive: true, force: true });

  console.log(`[fetch_embedding_model] installed: ${modelDir}`);
  console.log(`[fetch_embedding_model] onnx weights: ${onnxPath}`);
}

main().catch((err) => {
  console.error('[fetch_embedding_model] FAILED:', err.message);
  exit(1);
});
