// Read-only store copies for the Z1 replay: load them, admit rows as of a timestamp, resolve a cwd to its project and store.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', 'dist');
const distImport = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const { ambientSecretAdmit } = await distImport('api/index.js');
const { resolveProjectIdentity, classifyOriginProject } = await distImport('core/project-identity.js');
const { passesScopeFilterForRecall } = await distImport('store/recall-scope.js');

// ---------------------------------------------------------------------------
// Store loading (read-only, tenant 'default' only)
// ---------------------------------------------------------------------------

export function loadStore(dir) {
  const db = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, content, tags_json, created, pinned, superseded_by, origin_project, scope,
                source, confidence, extracted_from, dag_level
         FROM memories WHERE tenant_id = ?`,
      )
      .all('default');
    return rows.map((r) => ({
      id: String(r.id),
      content: String(r.content),
      tags: safeParseTags(r.tags_json),
      created: String(r.created),
      pinned: Boolean(r.pinned),
      superseded_by: r.superseded_by ?? null,
      origin_project: r.origin_project ?? null,
      scope: r.scope ?? null,
      // isWorthSurfacing judges by provenance, so without these every row would get a person's looser floor.
      source: String(r.source ?? ''),
      confidence: r.confidence ?? null,
      extracted_from: r.extracted_from ?? null,
      dag_level: Number(r.dag_level ?? 0),
    }));
  } finally {
    db.close();
  }
}

function safeParseTags(json) {
  try {
    const v = JSON.parse(String(json ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ---------------------------------------------------------------------------
// admit: not superseded, scope passes, secret rule, not cross-project
// ---------------------------------------------------------------------------

export function admitEntry(entry, tsMs, projectName) {
  if (entry.superseded_by) return false;
  if (!(Date.parse(entry.created) < tsMs)) return false;
  if (!passesScopeFilterForRecall(entry.scope, undefined)) return false;
  if (!ambientSecretAdmit(entry, projectName)) return false;
  if (classifyOriginProject(entry.origin_project, projectName) === 'cross-project') return false;
  return true;
}

// Admission at an arbitrary (cwd, ts), for the Z1b tool-failure query (not tied to a hook prompt).
export function admittedAt(resolvers, globalEntries, cwd, tsMs) {
  const projectName = resolvers.projectNameFor(cwd);
  const localEntries = resolvers.localEntriesFor(cwd);
  const localAdm = localEntries.filter((e) => admitEntry(e, tsMs, projectName));
  const globalAdm = globalEntries.filter((e) => admitEntry(e, tsMs, projectName));
  return { localAdm, globalAdm };
}

// ---------------------------------------------------------------------------
// cwd -> project name / local store (live disk walk, cached per cwd)
// ---------------------------------------------------------------------------

export function makeResolvers(home, storeMap) {
  const nameCache = new Map();
  const localCache = new Map();

  function projectNameFor(cwd) {
    let name = nameCache.get(cwd);
    if (name === undefined) {
      name = resolveProjectIdentity(cwd, { homeDir: home }).name;
      nameCache.set(cwd, name);
    }
    return name;
  }

  function localEntriesFor(cwd) {
    let result = localCache.get(cwd);
    if (result === undefined) {
      let dir = path.resolve(cwd);
      let root = null;
      for (let i = 0; i < 64; i++) {
        let isHippoDir = false;
        try {
          isHippoDir = fs.statSync(path.join(dir, '.hippo')).isDirectory();
        } catch {
          // no .hippo at this level; keep climbing
        }
        if (isHippoDir) {
          root = dir;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      result = [];
      if (root && !samePath(root, home)) {
        const mapped = storeMap.get(root.toLowerCase());
        if (mapped) result = mapped;
      }
      localCache.set(cwd, result);
    }
    return result;
  }

  return { projectNameFor, localEntriesFor };
}
