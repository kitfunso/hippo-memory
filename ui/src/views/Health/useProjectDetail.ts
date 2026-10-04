import { useEffect } from "react";
import { ApiError, fetchProject } from "../../api/client";
import { OVERVIEW_ROUTE, navigate } from "../../router";
import type { ProjectDetail } from "../../types";
import { useHealth } from "./HealthContext";
import { type Panel, usePanelCore } from "./usePanel";

export const DEAD_PROJECT_NOTICE = "That project has no memories any more";

/** The project panel on the snapshot clock; a 404 sends the user to the overview with the dead-link notice. */
export function useProjectDetail(key: string): Panel<ProjectDetail> {
  const { clock, setNotice } = useHealth();
  const panel = usePanelCore<ProjectDetail>(clock, ({ signal }) => fetchProject(key, { signal }), `project:${key}`);
  const dead = panel.error instanceof ApiError && panel.error.status === 404;
  useEffect(() => {
    if (!dead) return;
    setNotice(DEAD_PROJECT_NOTICE);
    navigate(OVERVIEW_ROUTE, { replace: true });
  }, [dead, setNotice]);
  return panel;
}
