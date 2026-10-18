// Per-process state the MCP tools share across calls: the recall rings' test seam and auto-sleep runs.

import { resetSessionRings } from '../api/recall/finish.js';

/** Test-only: reset the MCP recall rings. Call from beforeEach. */
export function _resetSessionRecallHistoryMcpForTests(): void {
  resetSessionRings('mcp');
}

export { autoSleepInFlight } from '../api/sleep/auto-sleep.js';
