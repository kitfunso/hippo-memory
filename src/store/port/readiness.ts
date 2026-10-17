

/** What GET /ready asks of a store. */
export interface Readiness {
  /** Resolves once one cheap read has answered; rejects with the store's own error when it cannot. */
  ping(): Promise<void>;
}
