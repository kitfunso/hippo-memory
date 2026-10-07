import { useCallback, useEffect } from "react";
import { type View } from "./components/ViewSwitch";
import { OVERVIEW_ROUTE, navigate, useRoute } from "./router";
import { Board } from "./views/Board/Board";
import { ActionsProvider } from "./views/Health/actions";
import { Header } from "./views/Health/Header";
import { HealthProvider, useHealth } from "./views/Health/HealthContext";
import { Overview } from "./views/Health/Overview";
import { ProjectView } from "./views/Health/ProjectView";
import { Tip } from "./views/Health/Tip";
import { Toast } from "./views/Health/Toast";

function Shell() {
  const route = useRoute();
  const { notice, setNotice, tip } = useHealth();
  const view: View = route.view === "board" ? "board" : "health";
  const projectKey = route.view === "health" ? route.projectKey : null;

  const changeView = useCallback((next: View) => {
    navigate(next === "board" ? { view: "board" } : OVERVIEW_ROUTE);
  }, []);

  useEffect(() => {
    if (projectKey !== null) setNotice(null);
  }, [projectKey, setNotice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tip.current?.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tip]);

  return (
    <div className="app">
      <Header view={view} onViewChange={changeView} />
      <main>
        {view === "health" && projectKey === null && <h1 className="sr-only">Memory health</h1>}
        {view === "health" && notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" className="btn quiet" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {route.view === "board" ? <Board /> : projectKey === null ? <Overview /> : <ProjectView key={projectKey} projectKey={projectKey} memoryId={route.memoryId} />}
      </main>
      <Tip ref={tip} />
      <Toast />
    </div>
  );
}

/** The dashboard: a shared header over the Health view or the Board, routed by hash. */
export function App() {
  const route = useRoute();
  return (
    <HealthProvider enabled={route.view === "health"}>
      <ActionsProvider>
        <Shell />
      </ActionsProvider>
    </HealthProvider>
  );
}
