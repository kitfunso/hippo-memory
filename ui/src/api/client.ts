import type {
  CardDetail,
  CardList,
  ForgetResult,
  Layer,
  MemoryDetail,
  MemoryPage,
  Overview,
  ProjectDetail,
  ResolveResult,
  SearchResult,
} from "../types";

const BASE = "";

export const ALL_LAYERS: readonly Layer[] = ["buffer", "episodic", "semantic", "trace"];

export type MemorySort = "content" | "layer" | "strength" | "retrievals" | "last" | "age" | "confidence" | "scope";
export type SortDir = "asc" | "desc";
export type Chip = "all" | "risk" | "pinned" | "conflict";

/** Query of the memory page route (plan 2.4); every field is optional and omitted when default. */
export interface MemoryPageQuery {
  offset?: number;
  limit?: number;
  sort?: MemorySort;
  dir?: SortDir;
  chip?: Chip;
  layers?: readonly Layer[];
  amin?: number;
  amax?: number;
  smin?: number;
  smax?: number;
  q?: string;
}

/** Options every read fetcher takes: abort signal and the Refresh-only rebuild flag. */
export interface ReadOptions {
  signal?: AbortSignal;
  fresh?: boolean;
}

/** A non-2xx response; `status` lets callers tell a 404 from a failure. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
}

async function failure(response: Response, path: string): Promise<ApiError> {
  let detail = "";
  try {
    const body: ErrorBody = await response.json();
    detail = body.error ?? body.message ?? "";
  } catch {
    detail = "";
  }
  return new ApiError(response.status, detail || `${response.status} ${response.statusText}: ${path}`);
}

async function get<T>(path: string, opts: ReadOptions = {}): Promise<T> {
  const url = opts.fresh ? `${path}${path.includes("?") ? "&" : "?"}fresh=1` : path;
  const response = await fetch(`${BASE}${url}`, { signal: opts.signal });
  if (!response.ok) throw await failure(response, path);
  return response.json();
}

type ActionBody = Record<string, string | boolean>;

async function post<T>(path: string, body: ActionBody, keepalive: boolean): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  if (!response.ok) throw await failure(response, path);
  return response.json();
}

/** Renders a caught fetch/parse error as UI text. Shared so App, Board and CardDialog stay in sync. */
export function errorMessage<T>(err: T): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `err` is an aborted fetch, which is never shown to the user. */
export function isAbort(err: Error): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Query string for the memory page; `layers` is left out when all four are on and never sent empty. */
export function memoryPageQueryString(query: MemoryPageQuery): string {
  const params = new URLSearchParams();
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.sort) params.set("sort", query.sort);
  if (query.dir) params.set("dir", query.dir);
  if (query.chip && query.chip !== "all") params.set("chip", query.chip);
  if (query.layers && query.layers.length > 0 && query.layers.length < ALL_LAYERS.length) {
    params.set("layers", ALL_LAYERS.filter((l) => query.layers!.includes(l)).join(","));
  }
  for (const key of ["amin", "amax", "smin", "smax"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, String(value));
  }
  const q = query.q?.trim();
  if (q && q.length >= 2) params.set("q", q);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** `GET /api/overview`. */
export function fetchOverview(opts?: ReadOptions): Promise<Overview> {
  return get<Overview>("/api/overview", opts);
}

/** `GET /api/projects/:key`. */
export function fetchProject(key: string, opts?: ReadOptions): Promise<ProjectDetail> {
  return get<ProjectDetail>(`/api/projects/${encodeURIComponent(key)}`, opts);
}

/** `GET /api/projects/:key/memories`: one page plus chip counts and the decay outlook. */
export function fetchMemoryPage(key: string, query: MemoryPageQuery, opts?: ReadOptions): Promise<MemoryPage> {
  return get<MemoryPage>(`/api/projects/${encodeURIComponent(key)}/memories${memoryPageQueryString(query)}`, opts);
}

/** `GET /api/memory/:id`: the drawer's detail. */
export function fetchMemory(id: string, opts?: ReadOptions): Promise<MemoryDetail> {
  return get<MemoryDetail>(`/api/memory/${encodeURIComponent(id)}`, opts);
}

/** `GET /api/search?q=`: `q` must be 2 to 200 characters. */
export function fetchSearch(q: string, opts?: ReadOptions): Promise<SearchResult> {
  return get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`, opts);
}

/** Options of the four actions; `keepalive` is for the commit on pagehide. */
export interface ActionOptions {
  keepalive?: boolean;
}

/** `POST /api/memory/:id/pin`. */
export function postPin(id: string, pinned: boolean, opts: ActionOptions = {}): Promise<MemoryDetail> {
  return post<MemoryDetail>(`/api/memory/${encodeURIComponent(id)}/pin`, { pinned }, opts.keepalive === true);
}

/** `POST /api/memory/:id/wrong`: sends `{}` so the JSON content type is accepted; answers the updated detail. */
export function postWrong(id: string, opts: ActionOptions = {}): Promise<MemoryDetail> {
  return post<MemoryDetail>(`/api/memory/${encodeURIComponent(id)}/wrong`, {}, opts.keepalive === true);
}

/** `POST /api/conflicts/:id/resolve`: keeps `keep`, weakens the other memory. */
export function postResolve(conflictId: number, keep: string, opts: ActionOptions = {}): Promise<ResolveResult> {
  return post<ResolveResult>(`/api/conflicts/${conflictId}/resolve`, { keep }, opts.keepalive === true);
}

/** `POST /api/memory/:id/forget`: sends `{}` so the JSON content type is accepted. */
export function postForget(id: string, opts: ActionOptions = {}): Promise<ForgetResult> {
  return post<ForgetResult>(`/api/memory/${encodeURIComponent(id)}/forget`, {}, opts.keepalive === true);
}

/** `GET /api/cards`. */
export function fetchCards(): Promise<CardList> {
  return get<CardList>("/api/cards");
}

/** `GET /api/cards/:id`. */
export function fetchCardDetail(id: string): Promise<CardDetail> {
  return get<CardDetail>(`/api/cards/${encodeURIComponent(id)}`);
}
