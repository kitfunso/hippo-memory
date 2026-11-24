import { execFileSync } from 'node:child_process';

const REPO_API = 'https://api.github.com/repos/kitfunso/hippo-memory';
const NPM_PUBLISH_DATE = '2026-03-15';
const NPM_API = `https://api.npmjs.org/downloads/point/${NPM_PUBLISH_DATE}:${new Date().toISOString().slice(0, 10)}/hippo-memory`;

const FALLBACK = { stars: 725, downloads: 25811 } as const;

export interface Stats {
  stars: number;
  downloads: number;
  starsLabel: string;
  downloadsLabel: string;
}

let cache: Promise<Stats> | null = null;

interface GitHubRepoResponse {
  stargazers_count?: unknown;
}

interface NpmDownloadsResponse {
  downloads?: unknown;
}

function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

// Anonymous GitHub API calls share a 60-an-hour limit per IP and 403 on a busy box; a token lifts it to 5,000.
function githubToken(): string | null {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}, ms = 3000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // SAFETY: this only names the property T expects to read off an
    // external JSON response — every caller runtime-checks each field's
    // actual type (isNumber() in getStats() below) before trusting it.
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

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

    const token = githubToken();
    try {
      const gh = await fetchJson<GitHubRepoResponse>(REPO_API, token ? { Authorization: `Bearer ${token}` } : {});
      if (isNumber(gh.stargazers_count)) stars = gh.stargazers_count;
      else throw new Error('no stargazers_count');
    } catch (err) {
      const hint = token ? '' : ' (no GitHub token: set GITHUB_TOKEN or run gh auth login)';
      console.warn(`[stats] GitHub stars fetch failed${hint}, using fallback ${FALLBACK.stars}:`, String(err));
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
