import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { type LoadOptions, type Panel, usePanelCore, useSnapshotClockState } from "./usePanel";

interface Snap {
  snapshotId: number;
}

interface Props {
  depsKey: string;
  load: (opts: LoadOptions) => Promise<Snap>;
  enabled: boolean;
}

const fails = (message: string) => () => Promise.reject(new Error(message));
const hangs = () => new Promise<Snap>(() => {});

// Records every render's result: the stale frame between a key change and its effect is the thing under test.
function mountPanel(initial: Props) {
  const renders: Panel<Snap>[] = [];
  const view = renderHook(
    (props: Props) => {
      const clock = useSnapshotClockState();
      const panel = usePanelCore<Snap>(clock, props.load, props.depsKey, props.enabled);
      renders.push(panel);
      return panel;
    },
    { initialProps: initial },
  );
  return { ...view, renders };
}

describe("usePanelCore key change", () => {
  it("a new key never shows the previous key's error, and reports loading while its load is pending", async () => {
    const { result, rerender, renders } = mountPanel({ depsKey: "a", load: fails("boom a"), enabled: true });
    await waitFor(() => expect(result.current.error?.message).toBe("boom a"));

    const before = renders.length;
    rerender({ depsKey: "b", load: hangs, enabled: true });

    const first = renders[before];
    expect(first.error).toBeNull();
    expect(first.loading).toBe(true);
    expect(first.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("a new key on a disabled panel reports not loading, even when the previous key was still loading", () => {
    const { result, rerender, renders } = mountPanel({ depsKey: "a", load: hangs, enabled: true });
    expect(result.current.loading).toBe(true);

    const before = renders.length;
    rerender({ depsKey: "b", load: hangs, enabled: false });

    expect(renders[before].loading).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("the same key keeps its error", async () => {
    const { result, rerender } = mountPanel({ depsKey: "a", load: fails("boom a"), enabled: true });
    await waitFor(() => expect(result.current.error?.message).toBe("boom a"));

    rerender({ depsKey: "a", load: hangs, enabled: true });

    expect(result.current.error?.message).toBe("boom a");
    expect(result.current.loading).toBe(false);
  });
});
