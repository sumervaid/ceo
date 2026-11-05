import { useEffect } from "react";
import { X } from "lucide-react";

import { bridge, call } from "./api";
import { Dialogs } from "./components/Dialogs";
import { HistoryPage, HomePage, InsightsPage, Onboarding, RacePage, SpendPage } from "./components/Pages";
import { addProjectFlow, Sidebar } from "./components/Sidebar";
import { Resizer, Spinner } from "./components/ui";
import { WorkspaceView } from "./components/WorkspaceView";
import { act, boot, useStore } from "./store";

function currentWorkspace() {
  const s = useStore.getState();
  return s.page.kind === "workspace" ? s.snapshot.workspaces.find((w) => w.id === (s.page as { id: string }).id) : undefined;
}

function runAction(action: string): void {
  const s = useStore.getState();
  const w = currentWorkspace();
  switch (action) {
    case "new-workspace": s.open({ kind: "new-workspace" }); break;
    case "new-race": s.open({ kind: "race" }); break;
    case "plan": s.open({ kind: "plan" }); break;
    case "add-project": void addProjectFlow(); break;
    case "settings": s.open({ kind: "settings" }); break;
    case "palette": s.open(s.dialog?.kind === "palette" ? null : { kind: "palette" }); break;
    case "shortcuts": s.open({ kind: "shortcuts" }); break;
    case "sidebar": s.toggleSidebar(); break;
    case "inspector": s.toggleInspector(); break;
    case "spend": s.setPage({ kind: "spend" }); break;
    case "insights": s.setPage({ kind: "insights" }); break;
    case "review": if (w) s.setReview(s.review ? null : { path: null }); break;
    case "terminal": if (w) { s.setReview(null); s.setInspector("terminal"); } break;
    case "run":
      if (w) {
        s.setReview(null);
        s.setInspector("run");
        const p = s.snapshot.projects.find((x) => x.id === w.projectId);
        if (p?.config.run.trim() && !w.scripts.run) void act(() => call("runScript", { id: w.id, kind: "run" }));
      }
      break;
    case "stop":
      if (w) for (const tabId of w.runningTabs) void call("stop", { id: w.id, tabId });
      break;
    case "archive": if (w && w.status !== "archived") void act(() => call("archiveWorkspace", { id: w.id }), `Archived ${w.title}`); break;
    case "create-pr": if (w) s.open({ kind: "create-pr", id: w.id }); break;
    case "new-tab":
      if (w) {
        const cur = w.tabs.find((t) => t.id === s.activeTab[w.id]) ?? w.tabs[0]!;
        void act(async () => s.setActiveTab(w.id, (await call("newTab", { id: w.id, provider: cur.provider, model: cur.model, mode: "build" })).id));
      }
      break;
    default: break;
  }
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} data-testid="toast">
          <span>{t.text}</span>
          {t.action && <button className="link" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

function useTheme(): void {
  const theme = useStore((s) => s.settings?.theme ?? "system");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.resolved = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const page = useStore((s) => s.page);
  const workspaces = useStore((s) => s.snapshot.workspaces);
  const races = useStore((s) => s.snapshot.races);
  const projects = useStore((s) => s.snapshot.projects);
  const readiness = useStore((s) => s.readiness);
  const settings = useStore((s) => s.settings);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setWidths = useStore((s) => s.setWidths);
  useTheme();

  useEffect(() => {
    void boot().catch((e: Error) => useStore.getState().toast(e.message, "error"));
    const offMenu = bridge.onMenu(runAction);
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const s = useStore.getState();
        const ordered = s.snapshot.projects.flatMap((p) => s.snapshot.workspaces.filter((w) => w.projectId === p.id && w.status !== "archived"));
        const w = ordered[Number(e.key) - 1];
        if (w) {
          e.preventDefault();
          s.setPage({ kind: "workspace", id: w.id });
        }
      }
      if (e.key === "Escape" && useStore.getState().review === null && useStore.getState().dialog === null) (document.activeElement as HTMLElement | null)?.blur?.();
    };
    window.addEventListener("keydown", onKey);
    const onFocus = (): void => {
      const s = useStore.getState();
      if (s.page.kind === "workspace") void call("markRead", { id: s.page.id });
      void s.refreshReadiness(false);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      offMenu();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!ready) return <div className="boot"><Spinner size={18} /></div>;

  const needsOnboarding = !settings?.onboarded && (projects.length === 0 || !readiness.some((r) => r.ready));
  if (needsOnboarding) {
    return <><Onboarding /><Dialogs /><Toasts /></>;
  }

  const w = page.kind === "workspace" ? workspaces.find((x) => x.id === page.id) : undefined;
  const race = page.kind === "race" ? races.find((r) => r.id === page.id) : undefined;

  return (
    <div className="shell">
      {sidebarOpen && (
        <div className="side-wrap" style={{ width: sidebarWidth }}>
          <Sidebar />
          <Resizer side="right" onDrag={(x) => setWidths({ sidebarWidth: Math.min(Math.max(x, 220), 440) })} />
        </div>
      )}
      {w ? <WorkspaceView key={w.id} w={w} />
        : page.kind === "spend" ? <SpendPage />
        : page.kind === "insights" ? <InsightsPage />
        : page.kind === "history" ? <HistoryPage />
        : race ? <RacePage race={race} />
        : <HomePage />}
      <Dialogs />
      <Toasts />
    </div>
  );
}
