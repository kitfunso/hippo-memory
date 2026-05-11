#!/usr/bin/env node
/**
 * Fetch a `@xenova/transformers`-compatible embedding model bundle from the
 * Qdrant fastembed Google Cloud Storage bucket and lay it out in the
 * library's local-cache directory structure.
 *
 * Why this script exists: in egress-restricted environments (e.g. Claude
 * Code Cloud sandboxes) `huggingface.co` is not allowlisted, so the default
 * @xenova/transformers download path fails. Qdrant publishes a curated set
 * of ONNX-converted models on storage.googleapis.com, which is on common
 * allowlists.
 *
 * Supported models (`--model <id>`):
 *
 *   Xenova/all-MiniLM-L6-v2          (384-dim,  mean pooling, FP32 model.onnx, ~80 MB tarball)
 *   Xenova/bge-base-en-v1.5          (768-dim,  CLS pooling,  FP16 model_optimized.onnx, ~195 MB tarball)
 *   Xenova/multilingual-e5-large     (1024-dim, mean pooling, FP32 model.onnx + model.onnx_data external-data, ~1.25 GB tarball)
 *
 * Layout produced (matches @xenova/transformers' local-model expectations):
 *
 *   <dest>/<model-id>/
 *     config.json
 *     tokenizer.json
 *     tokenizer_config.json
 *     special_tokens_map.json
 *     vocab.txt
 *     onnx/
 *       model.onnx       (renamed from whichever ONNX file the tarball ships)
 *
 * Pair with the HIPPO_MODEL_CACHE env var (consumed by src/embeddings.ts):
 *
 *   HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache \
 *     node bin/hippo.js embed
 *
 * src/embeddings.ts auto-detects whether the bundle is quantized (presence
 * of `onnx/model_quantized.onnx`) or FP32/optimized (presence of
 * `onnx/model.onnx`) and passes the right flag to `pipeline()`. Both
 * Qdrant bundles end up with a single `model.onnx`, so the runtime picks
 * the non-quantized path.
 *
 * Idempotent: skips download + extraction when the target tree already
 * contains a non-empty `onnx/model.onnx`. Run with `--force` to re-fetch.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';

/**
 * Per-model fetch + extraction config.
 * Add a new model by appending an entry here; no other code change needed.
 * `md5Base64` comes from the GCS object's `x-goog-hash` header (verifiable
 * with `curl -sSI <url> | grep -i md5=`).
 */
const MODELS = {
  'Xenova/all-MiniLM-L6-v2': {
    url: 'https://storage.googleapis.com/qdrant-fastembed/sentence-transformers-all-MiniLM-L6-v2.tar.gz',
    md5Base64: 'ES1rh090kuh/nhAyKdCO0A==',
    tarPrefix: 'fast-all-MiniLM-L6-v2',
    onnxFileInTarball: 'model.onnx',
    onnxExternalData: null,
  },
  'Xenova/bge-base-en-v1.5': {
    url: 'https://storage.googleapis.com/qdrant-fastembed/fast-bge-base-en-v1.5.tar.gz',
    md5Base64: 'zD+/65myZ/5XsJN3BDO92w==',
    tarPrefix: 'fast-bge-base-en-v1.5',
    onnxFileInTarball: 'model_optimized.onnx',
    onnxExternalData: null,
  },
  'Xenova/multilingual-e5-large': {
    url: 'https://storage.googleapis.com/qdrant-fastembed/fast-multilingual-e5-large.tar.gz',
    md5Base64: 'qfG9AF6uyVOG9RgHd1XpLA==',
    tarPrefix: 'fast-multilingual-e5-large',
    onnxFileInTarball: 'model.onnx',
    onnxExternalData: 'model.onnx_data',  // ONNX external-data sidecar, must live next to model.onnx
  },
};

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
// Required files (must be present in the tarball)
const FILES_REQUIRED = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];
// Optional files (copied if present; absent files do NOT fail extraction)
const FILES_OPTIONAL = [
  'vocab.txt',  // WordPiece-tokenized models (BERT family); absent for SentencePiece (XLM-R)
];

function parseArgs(args) {
  const out = { dest: null, force: false, model: DEFAULT_MODEL };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dest') out.dest = args[++i];
    else if (a === '--model') out.model = args[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/fetch_embedding_model.mjs [--model <ID>] [--dest <DIR>] [--force]

Supported --model values:
  ${Object.keys(MODELS).join('\n  ')}`);
      exit(0);
    }
  }
  if (!out.dest) {
    out.dest = process.env.HIPPO_MODEL_CACHE
      || resolve('benchmarks/longmemeval/data/model-cache');
  }
  if (!MODELS[out.model]) {
    console.error(`[fetch_embedding_model] unknown --model ${out.model}; supported: ${Object.keys(MODELS).join(', ')}`);
    exit(2);
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
  // --exclude='._*' drops macOS resource-fork files that fastembed tarballs
  // produced on darwin sometimes ship (e.g. multilingual-e5-large).
  const res = spawnSync('tar', ['-xzf', tarPath, '-C', destDir, '--exclude=._*'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) {
    throw new Error(`tar extraction failed (exit ${res.status}): ${res.stderr?.toString() || ''}`);
  }
}

function arrangeXenovaLayout(extractedRoot, targetDir, cfg) {
  const src = join(extractedRoot, cfg.tarPrefix);
  if (!existsSync(src)) {
    throw new Error(`expected directory not found after extraction: ${src}`);
  }

  mkdirSync(join(targetDir, 'onnx'), { recursive: true });

  for (const name of FILES_REQUIRED) {
    const srcPath = join(src, name);
    if (!existsSync(srcPath)) {
      throw new Error(`missing required file in tarball: ${name}`);
    }
    writeFileSync(join(targetDir, name), readFileSync(srcPath));
  }

  for (const name of FILES_OPTIONAL) {
    const srcPath = join(src, name);
    if (existsSync(srcPath)) {
      writeFileSync(join(targetDir, name), readFileSync(srcPath));
    }
  }

  const onnxSrc = join(src, cfg.onnxFileInTarball);
  if (!existsSync(onnxSrc)) {
    throw new Error(`missing ${cfg.onnxFileInTarball} in tarball`);
  }
  // copyFileSync streams; readFileSync/writeFileSync would hit Node's 2 GiB
  // buffer cap (e5-large's external-data sidecar is 2.2 GB).
  copyFileSync(onnxSrc, join(targetDir, 'onnx', 'model.onnx'));

  // ONNX external-data: if the tarball ships a sidecar (e.g. model.onnx_data),
  // it must live next to model.onnx for onnxruntime to resolve the weights.
  if (cfg.onnxExternalData) {
    const extSrc = join(src, cfg.onnxExternalData);
    if (!existsSync(extSrc)) {
      throw new Error(`missing onnx external-data sidecar in tarball: ${cfg.onnxExternalData}`);
    }
    // ONNX resolves external-data by exact filename reference inside the .onnx
    // graph — keep the original name (model.onnx_data, not model.data).
    copyFileSync(extSrc, join(targetDir, 'onnx', cfg.onnxExternalData));
  }
}

async function main() {
  const { dest, force, model } = parseArgs(argv.slice(2));
  const cfg = MODELS[model];
  const modelDir = join(resolve(dest), model);
  const onnxPath = join(modelDir, 'onnx', 'model.onnx');

  if (!force && existsSync(onnxPath) && statSync(onnxPath).size > 1_000_000) {
    console.log(`[fetch_embedding_model] already present: ${onnxPath}`);
    return;
  }

  console.log(`[fetch_embedding_model] model: ${model}`);
  console.log(`[fetch_embedding_model] dest:  ${dest}`);
  console.log(`[fetch_embedding_model] downloading from ${cfg.url} ...`);
  const tmpRoot = join(resolve(dest), '.fetch-tmp');
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });

  const tarPath = join(tmpRoot, 'model.tar.gz');
  const t0 = Date.now();
  await downloadTo(cfg.url, tarPath);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMb = (statSync(tarPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[fetch_embedding_model] downloaded ${sizeMb} MB in ${dt}s`);

  const md5 = md5Base64(tarPath);
  if (md5 !== cfg.md5Base64) {
    throw new Error(`MD5 mismatch: got ${md5}, expected ${cfg.md5Base64}`);
  }
  console.log(`[fetch_embedding_model] MD5 verified: ${md5}`);

  const extractDir = join(tmpRoot, 'extract');
  extractTarball(tarPath, extractDir);

  // Stage to a fresh target then move into place atomically.
  const stagingDir = join(tmpRoot, 'staged');
  arrangeXenovaLayout(extractDir, stagingDir, cfg);

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
