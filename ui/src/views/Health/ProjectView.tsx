import { keyLabel, projectLabel } from "./format";
import { useProjectDetail } from "./useProjectDetail";

/** Placeholder for the project view (scatter, decay, memory table and drawer arrive next). */
export function ProjectView({ projectKey }: { projectKey: string; memoryId: string | null }) {
  const detail = useProjectDetail(projectKey);
  const name = detail.data ? projectLabel(detail.data.summary) : keyLabel(projectKey);
  return (
    <section className="view" aria-labelledby="pv-name">
      <h1 id="pv-name" className="pv-h1 ell">
        {name}
      </h1>
      {detail.loading && <p role="status">loading</p>}
    </section>
  );
}
