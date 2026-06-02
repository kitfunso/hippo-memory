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
const NPM_API = 'https://api.npmjs.org/downloads/point/last-month/hippo-memory';

// Last-known values (2026-06-02), used only when a fetch fails.
const FALLBACK = { stars: 679, downloads: 9858 } as const;

export interface Stats {
  stars: number;
  downloads: number;
  starsLabel: string;
  downloadsLabel: string;
}

let cache: Promise<Stats> | null = null;

async function fetchJson(url: string, ms = 3000): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
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
      const gh = await fetchJson(REPO_API);
      if (typeof gh.stargazers_count === 'number') stars = gh.stargazers_count;
      else throw new Error('no stargazers_count');
    } catch (err) {
      console.warn(`[stats] GitHub stars fetch failed, using fallback ${FALLBACK.stars}:`, String(err));
    }

    try {
      const npm = await fetchJson(NPM_API);
      if (typeof npm.downloads === 'number') downloads = npm.downloads;
      else throw new Error('no downloads');
    } catch (err) {
      console.warn(`[stats] npm downloads fetch failed, using fallback ${FALLBACK.downloads}:`, String(err));
    }

    return { stars, downloads, starsLabel: compact(stars), downloadsLabel: compact(downloads) };
  })();
  return cache;
}
