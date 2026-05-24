/**
 * Debounce a fast-changing value. The returned value updates only after
 * `delayMs` has elapsed without further changes to `value`.
 *
 * Used by E2 search input (150ms) to avoid recomputing scene.setHighlighted
 * on every keystroke. Plan v2 round-2 LOW #9 + LOW #1 fix.
 */

import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
