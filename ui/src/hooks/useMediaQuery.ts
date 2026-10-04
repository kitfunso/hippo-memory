import { useSyncExternalStore } from "react";

/** Width at or below which the dashboard uses its phone layout (layout keys on width only). */
export const PHONE_QUERY = "(max-width: 760px)";

function subscribeTo(query: string) {
  return (notify: () => void) => {
    const mq = window.matchMedia?.(query);
    if (!mq) return () => {};
    mq.addEventListener("change", notify);
    return () => mq.removeEventListener("change", notify);
  };
}

function matches(query: string): boolean {
  return window.matchMedia?.(query).matches === true;
}

/** Live `matchMedia` result; false where matchMedia is missing (jsdom). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(subscribeTo(query), () => matches(query), () => false);
}

/** True at the phone breakpoint. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** True when the user asked for reduced motion; read at call time by animations. */
export function prefersReducedMotion(): boolean {
  return matches("(prefers-reduced-motion: reduce)");
}
