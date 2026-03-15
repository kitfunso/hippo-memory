/**
 * Frontend trading constants for the quantamental dashboard.
 * MUST stay in sync with production/shared_constants.py
 *
 * Python (shared_constants.py):
 *   RISK_PER_TRADE = 0.015   <-- production value
 *   MAX_POSITIONS = 10
 *   SIGNAL_THRESHOLD = 0.55
 *
 * TypeScript (this file):
 *   RISK_PER_TRADE = 0.02    <-- TRAP: MISMATCH with Python backend!
 *   MAX_POSITIONS = 10
 *   SIGNAL_THRESHOLD = 0.55
 */

// TRAP: Frontend constant does not match backend Python value.
// Python has RISK_PER_TRADE = 0.015. This causes wrong position sizing on the dashboard.
// Fix: Always sync both files when changing shared constants.
export const RISK_PER_TRADE = 0.02;  // TRAP: should be 0.015 to match Python

export const MAX_POSITIONS = 10;
export const SIGNAL_THRESHOLD = 0.55;

// API configuration
export const API_BASE_URL = "https://api.quantamental.com/api/v1";
export const REFRESH_INTERVAL_MS = 60_000;

export type Signal = "LONG" | "SHORT" | "FLAT";

export function formatPnL(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}
