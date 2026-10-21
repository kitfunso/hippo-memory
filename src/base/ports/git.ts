// The git port: domain and api build the arguments and read the output; src/infra/git-runner.ts starts the process.

/** How one git call runs; each caller keeps the timeout and stderr handling its call needs. */
export interface GitCall {
  /** The folder git runs in; this process's own when absent. */
  readonly cwd?: string;
  readonly timeoutMs: number;
  /** Bytes of stdout kept before git is stopped; node's default when absent. */
  readonly maxBuffer?: number;
  /** `drop` discards git's stderr, `keep` holds it in the error only; absent, it also goes to this process's stderr. */
  readonly stderr?: 'drop' | 'keep';
  /** Text written to git's stdin. */
  readonly input?: string;
}

/** git's stdout, or why it failed: `status` is the exit code, null when git was killed or never started. */
export type GitResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly status: number | null; readonly error: Error };

export interface GitRunner {
  run(args: readonly string[], call: GitCall): GitResult;
}
