/**
 * Build-time social proof. Astro SSG runs component frontmatter at BUILD, so this
 * fetches GitHub stars + npm downloads once per build and bakes the numbers into the
 * static HTML. No runtime fetch, no cookies.
 *
 * Robust by design: AbortController timeout (native fetch has no timeout option) +
 * try/catch per source -> falls back to last-known constants so an offline / CI build
 * NEVER fails. The module-level promise cache means many awaits = one fetch, and the
 * cached promise never rejects (all errors are caught internally). A fallback emits a
 * build-log warning so a persistently-failing fetch is noticed, not silently shipped.
 */

const REPO_API = 'https://api.github.com/repos/kitfunso/hippo-memory';
// hippo-memory's first npm publish date. Lifetime total, not last-month: a monotonic
// headline number reads better than a monthly figure that dips between release spikes,
// and matches how the milestone is talked about elsewhere (README, announcements).
const NPM_PUBLISH_DATE = '2026-03-15';
const NPM_API = `https://api.npmjs.org/downloads/point/${NPM_PUBLISH_DATE}:${new Date().toISOString().slice(0, 10)}/hippo-memory`;

// Last-known values (2026-08-09), used only when a fetch fails.
const FALLBACK = { stars: 725, downloads: 25811 } as const;

export interface Stats {
  stars: number;
  downloads: number;
  starsLabel: string;
  downloadsLabel: string;
}

let cache: Promise<Stats> | null = null;

/** GitHub repo API response — only the field this module reads. Its value
 * is left `unknown` because the actual response is external, untyped
 * input; callers runtime-check it (see getStats() below) before use. */
interface GitHubRepoResponse {
  stargazers_count?: unknown;
}

/** npm downloads-point API response — same "unknown until checked" shape
 * as GitHubRepoResponse, for the same reason. */
interface NpmDownloadsResponse {
  downloads?: unknown;
}

function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

async function fetchJson<T>(url: string, ms = 3000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // SAFETY: this only names the property T expects to read off an
    // external JSON response — every caller runtime-checks each field's
    // actual type (isNumber() in getStats() below) before trusting it.
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 9858 -> "9.9k", 679 -> "679", 1200000 -> "1.2M". */
function compact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

export function getStats(): Promise<Stats> {
  if (cache) return cache;
  cache = (async () => {
    let stars = FALLBACK.stars;
    let downloads = FALLBACK.downloads;

    try {
      const gh = await fetchJson<GitHubRepoResponse>(REPO_API);
      if (isNumber(gh.stargazers_count)) stars = gh.stargazers_count;
      else throw new Error('no stargazers_count');
    } catch (err) {
      console.warn(`[stats] GitHub stars fetch failed, using fallback ${FALLBACK.stars}:`, String(err));
    }

    try {
      const npm = await fetchJson<NpmDownloadsResponse>(NPM_API);
      if (isNumber(npm.downloads)) downloads = npm.downloads;
      else throw new Error('no downloads');
    } catch (err) {
      console.warn(`[stats] npm downloads fetch failed, using fallback ${FALLBACK.downloads}:`, String(err));
    }

    return { stars, downloads, starsLabel: compact(stars), downloadsLabel: compact(downloads) };
  })();
  return cache;
}
