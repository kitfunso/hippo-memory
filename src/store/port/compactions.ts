// The Compactions group, kept apart from port.ts: the record and items of a compaction a caller on another machine
// sends, under the caller's tenant and project, never the server's folder or environment.

export interface Compactions {
  /** A `started` record; its id. */
  start(tenantId: string, start: CompactionStart): Promise<string>;
  /** Marks the record as having its snapshot saved; an id the tenant does not hold changes nothing. */
  markSnapshotSaved(tenantId: string, recordId: string): Promise<void>;
  /** The items under the request's record, all in one transaction, so two sessions never both write one text; a
   * request id another session holds rejects with ConflictError. */
  saveCallerItems(tenantId: string, req: CallerItems): Promise<CallerItemsSaved>;
}

export interface CallerItemsSaved {
  /** Memories written; a retry of a finished request answers with the first count. */
  readonly written: number;
  /** One line per kind of item left out, and why. */
  readonly notes: readonly string[];
}

export interface CompactionStart {
  sessionId: string;
  originProject: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
}

export interface CallerItems {
  readonly sessionId: string;
  readonly trigger: string | null;
  readonly requestId: string;
  readonly project: string;
  readonly items: readonly string[];
  /** The caller's audit actor and its project's names. */
  readonly owner: string;
  readonly origins: readonly string[];
  /** The config default the caller's items start on. */
  readonly baseHalfLifeDays: number;
}
