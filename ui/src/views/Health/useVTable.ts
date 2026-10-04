import { type KeyboardEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clamp } from "./format";

const OVERSCAN = 4;
const FALLBACK_HEIGHT = 400;

/** Options of the virtual list: one fixed row height and a total row count. */
export interface UseVTableOptions {
  rowHeight: number;
  count: number;
  onActivate: (index: number) => void;
  /** Called when the active row changes (keyboard or click). */
  onFocusRow?: (index: number) => void;
  /** Visible plus overscan row range changed; the memory table pages from this. */
  onWindow?: (first: number, last: number) => void;
  /** Changing this value scrolls to the top and clears the active row (sort or filter changed). */
  resetKey?: unknown;
  /** Sticky header inside the scroller; its height is not row space. */
  headRef?: RefObject<HTMLElement | null>;
}

/** Windowing and keyboard state of a virtual list, ported from the mockup's VTable. */
export interface VTableState {
  rootRef: RefObject<HTMLDivElement | null>;
  /** First and one-past-last row to render. */
  first: number;
  last: number;
  active: number;
  setActive: (index: number, scroll: boolean) => void;
  onScroll: () => void;
  onRootKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onRootFocus: () => void;
}

/** Hook behind `VTable`; also usable by a card-list variant that renders its own rows. */
export function useVTable(opts: UseVTableOptions): VTableState {
  const { rowHeight, count, onActivate, onFocusRow, onWindow, resetKey, headRef } = opts;
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: FALLBACK_HEIGHT });
  const [active, setActiveState] = useState(-1);
  const frame = useRef(0);

  // The root is the scroller, so the sticky header covers the top of its client box.
  const rowsHeight = useCallback(() => {
    const room = (rootRef.current?.clientHeight ?? 0) - (headRef?.current?.offsetHeight ?? 0);
    return room > 0 ? room : FALLBACK_HEIGHT;
  }, [headRef]);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    setView((v) => {
      const next = { top: root.scrollTop, height: rowsHeight() };
      return v.top === next.top && v.height === next.height ? v : next;
    });
  }, [rowsHeight]);

  useLayoutEffect(() => {
    measure();
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const firstResetKey = useRef(resetKey);
  useEffect(() => {
    if (firstResetKey.current === resetKey) return;
    firstResetKey.current = resetKey;
    if (rootRef.current) rootRef.current.scrollTop = 0;
    setActiveState(-1);
    measure();
  }, [resetKey, measure]);

  useEffect(() => {
    setActiveState((a) => (a >= count ? count - 1 : a));
  }, [count]);

  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN);
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN);

  useEffect(() => {
    if (count > 0) onWindow?.(first, last);
  }, [first, last, count, onWindow]);

  const setActive = useCallback(
    (index: number, scroll: boolean) => {
      setActiveState(index);
      const root = rootRef.current;
      if (scroll && root) {
        const top = index * rowHeight;
        const room = rowsHeight();
        if (top < root.scrollTop) root.scrollTop = top;
        else if (top + rowHeight > root.scrollTop + room) root.scrollTop = top + rowHeight - room;
        measure();
      }
      onFocusRow?.(index);
    },
    [rowHeight, measure, rowsHeight, onFocusRow],
  );

  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  }, [measure]);

  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== rootRef.current) return;
    const page = Math.max(1, Math.floor(rowsHeight() / rowHeight) - 1);
    const moves = new Map([["ArrowDown", 1], ["ArrowUp", -1], ["PageDown", page], ["PageUp", -page], ["Home", -1e9], ["End", 1e9]]);
    const move = moves.get(e.key);
    if (move !== undefined && count > 0) {
      e.preventDefault();
      setActive(clamp((active < 0 ? -1 : active) + move, 0, count - 1), true);
    } else if ((e.key === "Enter" || e.key === " ") && active >= 0) {
      e.preventDefault();
      onActivate(active);
    }
  };

  const onRootFocus = () => {
    if (active < 0 && count > 0) setActive(0, true);
  };

  return { rootRef, first, last, active, setActive, onScroll, onRootKeyDown, onRootFocus };
}
