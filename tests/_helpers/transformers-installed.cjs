// Preloaded into a spawned node: only the Transformers.js packages named in TRANSFORMERS_INSTALLED resolve, whatever is on disk.
const Module = require('node:module');

const TRANSFORMERS = new Set(['@xenova/transformers', '@huggingface/transformers']);
const installed = new Set((process.env.TRANSFORMERS_INSTALLED ?? '').split(',').filter(Boolean));
const realResolve = Module._resolveFilename;

Module._resolveFilename = function resolveOnlyInstalled(request, ...rest) {
  if (!TRANSFORMERS.has(request)) return realResolve.call(this, request, ...rest);
  if (installed.has(request)) return request;
  throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
};
