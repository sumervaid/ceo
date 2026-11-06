import { useMemo, useState } from "react";
import {
  Archive, BarChart3, Check, ChevronRight, CircleDollarSign, Crown, Flag, GitPullRequest, History, Inbox, Layers, Plus, Search, Settings as SettingsIcon, Sparkles, Trophy, TriangleAlert, Users,
} from "lucide-react";

import type { Project, Workspace } from "../../shared/api";
import { call } from "../api";
import { mod, SHIFT } from "../format";
import { act, useStore } from "../store";
import { Button, Kbd, Menu, ProviderMark, Spinner } from "./ui";

export function StatusGlyph({ w }: { w: Workspace }) {
  if (w.status === "creating" || w.status === "setup" || w.activity === "running") return <Spinner size={11} />;
  if (w.activity === "error") return <TriangleAlert size={12} className="glyph-err" />;
  if (w.mergedAt || w.pr?.state === "MERGED") return <Check size={12} className="glyph-merged" />;
  if (w.pr) return <GitPullRequest size={12} className="glyph-pr" />;
  if (w.activity === "unread") return <span className="dot dot-unread" />;
  if (w.activity === "queued") return <span className="dot dot-queued" />;
  return <span className="dot" />;
}

function Row({ w, index }: { w: Workspace; index: number | null }) {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const active = page.kind === "workspace" && page.id === w.id;
  const provider = w.tabs[0]?.provider;
  return (
    <div className={`wsrow ${active ? "wsrow-active" : ""} ${w.activity === "unread" ? "wsrow-unread" : ""}`} data-testid={`ws-${w.slug}`} role="button" tabIndex={0} onClick={() => setPage({ kind: "workspace", id: w.id })} onKeyDown={(e) => e.key === "Enter" && setPage({ kind: "workspace", id: w.id })}>
      <span className="wsrow-status"><StatusGlyph w={w} /></span>
      <span className="wsrow-main">
        <span className="wsrow-title">{w.title}</span>
        <span className="wsrow-sub">
          {provider && <ProviderMark provider={provider} size={6} />}
          <span>{w.slug}</span>
          {w.git.files > 0 && (
            <span className="wsrow-diff">
              <em className="add">+{w.git.added}</em> <em className="del">−{w.git.removed}</em>
            </span>
          )}
        </span>
      </span>
      <span className="wsrow-end">
        {index !== null && index < 9 && <span className="wsrow-index">{mod(String(index + 1))}</span>}
        <button
          className="wsrow-archive"
          title="Archive"
          aria-label="Archive"
          onClick={(e) => {
            e.stopPropagation();
            void act(() => call("archiveWorkspace", { id: w.id }), `Archived ${w.title}`);
          }}
        >
          <Archive size={13} />
        </button>
      </span>
    </div>
  );
}

function TeamRow({ p }: { p: Project }) {
  const summary = useStore((s) => s.snapshot.org[p.id]);
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const active = page.kind === "org" && page.projectId === p.id;
  if (!p.isGit) return null;
  const sub = !summary || (!summary.hasChief && summary.agents === 0)
    ? "Chief of staff and headless agents"
    : [summary.hasChief ? "Chief of staff" : null, summary.agents ? `${summary.agents} agent${summary.agents === 1 ? "" : "s"}` : null, summary.queued ? `${summary.queued} queued` : null].filter(Boolean).join(" · ");
  const go = (): void => setPage({ kind: "org", projectId: p.id, tab: active && page.kind === "org" ? page.tab : summary?.hasChief ? "chief" : "team" });
  return (
    <div className={`wsrow teamrow ${active ? "wsrow-active" : ""}`} role="button" tabIndex={0} onClick={go} onKeyDown={(e) => e.key === "Enter" && go()} data-testid={`team-${p.name}`}>
      <span className="wsrow-status">{summary?.running || summary?.replying ? <Spinner size={11} /> : summary?.hasChief ? <Crown size={12} className="accent" /> : <Users size={12} className="muted" />}</span>
      <span className="wsrow-main">
        <span className="wsrow-title">Team</span>
        <span className="wsrow-sub"><span>{summary?.running ? `${summary.running} working` : sub}</span></span>
      </span>
      {!!summary?.approvals && (
        <button className="team-approvals" title={`${summary.approvals} waiting for a decision`} onClick={(e) => { e.stopPropagation(); setPage({ kind: "org", projectId: p.id, tab: "approvals" }); }} data-testid={`approvals-${p.name}`}>
          <Inbox size={11} />{summary.approvals}
        </button>
      )}
    </div>
  );
}

function ProjectGroup({ p, list, indexOf }: { p: Project; list: Workspace[]; indexOf: (w: Workspace) => number | null }) {
  const collapsed = useStore((s) => !!s.collapsed[p.id]);
  const toggle = useStore((s) => s.toggleCollapsed);
  const open = useStore((s) => s.open);
  return (
    <section className="group" data-testid={`project-${p.name}`}>
      <div className="group-head">
        <button className="group-toggle" onClick={() => toggle(p.id)}>
          <ChevronRight size={12} className={collapsed ? "" : "rot90"} />
          <span>{p.name}</span>
        </button>
        <div className="group-actions">
          <Menu
            align="right"
            trigger={(_o, t) => <button className="iconbtn" onClick={t} aria-label="Project menu"><SettingsIcon size={12} /></button>}
            items={[
              { label: "Project settings", onClick: () => open({ kind: "project", projectId: p.id }) },
              { label: "Open in Finder", onClick: () => void window.ceo.desktop.openPath(p.path) },
              { separator: true, label: "" },
              {
                label: "Remove from CEO", danger: true,
                onClick: () => open({ kind: "confirm", title: `Remove ${p.name}?`, body: "The folder, branches and ledger stay on disk. The project leaves this list.", action: "Remove", danger: true, run: () => void act(() => call("removeProject", { projectId: p.id })) }),
              },
            ]}
          />
          <button className="iconbtn" onClick={() => open({ kind: "new-workspace", projectId: p.id })} aria-label={`New workspace in ${p.name}`}><Plus size={13} /></button>
        </div>
      </div>
      {!collapsed && <TeamRow p={p} />}
      {!collapsed && list.map((w) => <Row key={w.id} w={w} index={indexOf(w)} />)}
      {!collapsed && list.length === 0 && (
        <button className="group-empty" onClick={() => open({ kind: "new-workspace", projectId: p.id })}>No active workspaces</button>
      )}
    </section>
  );
}

export function Sidebar() {
  const { projects, workspaces } = useStore((s) => s.snapshot);
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const open = useStore((s) => s.open);
  const license = useStore((s) => s.license);
  const [query, setQuery] = useState("");

  const active = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workspaces.filter((w) => w.status !== "archived" && (!q || `${w.title} ${w.slug} ${w.branch}`.toLowerCase().includes(q)));
  }, [workspaces, query]);

  const ordered = useMemo(() => projects.flatMap((p) => active.filter((w) => w.projectId === p.id)), [projects, active]);
  const indexOf = (w: Workspace): number | null => {
    const i = ordered.findIndex((x) => x.id === w.id);
    return i >= 0 ? i : null;
  };
  const archived = workspaces.filter((w) => w.status === "archived").length;
  const org = useStore((s) => s.snapshot.org);
  const running = workspaces.filter((w) => w.runningTabs.length > 0).length + Object.values(org).reduce((n, o) => n + o.running, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <div className="brand no-drag" role="button" tabIndex={0} onClick={() => setPage({ kind: "home" })} onKeyDown={(e) => e.key === "Enter" && setPage({ kind: "home" })}>CEO</div>
        {running > 0 && <span className="brand-live"><Spinner size={9} /> {running} running</span>}
      </div>
      <div className="sidebar-actions">
        <div className="splitbtn">
          <Button tone="primary" size="md" className="splitbtn-main" icon={<Plus size={14} />} onClick={() => open({ kind: "new-workspace" })} data-testid="new-workspace">
            New workspace
          </Button>
          <Menu
            align="right"
            trigger={(_o, t) => <Button tone="primary" size="md" className="splitbtn-more" onClick={t} aria-label="More ways to start" icon={<ChevronRight size={13} className="rot90" />} />}
            items={[
              { icon: <Plus size={14} />, label: "New workspace", detail: `${mod(SHIFT)}N`, onClick: () => open({ kind: "new-workspace" }) },
              { icon: <Flag size={14} />, label: "Race agents", detail: "One task, several agents. A check picks the winner.", onClick: () => open({ kind: "race" }) },
              { icon: <Sparkles size={14} />, label: "Plan from a goal", detail: "One goal becomes separate workspaces.", onClick: () => open({ kind: "plan" }) },
              { separator: true, label: "" },
              { icon: <Layers size={14} />, label: "Add project", detail: mod("O"), onClick: () => void addProjectFlow() },
            ]}
          />
        </div>
        <div className="search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter workspaces" aria-label="Filter workspaces" />
          <Kbd>{mod("K")}</Kbd>
        </div>
      </div>
      <div className="sidebar-list">
        {projects.map((p) => (
          <ProjectGroup key={p.id} p={p} list={active.filter((w) => w.projectId === p.id)} indexOf={indexOf} />
        ))}
        {projects.length === 0 && (
          <button className="group-empty" onClick={() => void addProjectFlow()}>Add a project to begin</button>
        )}
      </div>
      <div className="sidebar-foot">
        {license && license.plan !== "pro" && (
          <button className="plan-chip" data-testid="plan-chip" onClick={() => open({ kind: "upgrade" })}>
            <Trophy size={12} />
            {license.plan === "trial" ? `Pro trial · ${license.trialDaysLeft} days left` : "Free plan · Upgrade"}
          </button>
        )}
        <nav className="sidebar-nav">
          <NavBtn label="Spend" active={page.kind === "spend"} onClick={() => setPage({ kind: "spend" })} icon={<CircleDollarSign size={15} />} />
          <NavBtn label="Insights" active={page.kind === "insights"} onClick={() => setPage({ kind: "insights" })} icon={<BarChart3 size={15} />} />
          <NavBtn label={archived ? `History, ${archived} archived` : "History"} active={page.kind === "history"} onClick={() => setPage({ kind: "history" })} icon={<History size={15} />} />
          <NavBtn label="Settings" onClick={() => open({ kind: "settings" })} icon={<SettingsIcon size={15} />} />
        </nav>
      </div>
    </aside>
  );
}

function NavBtn({ label, icon, onClick, active }: { label: string; icon: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button className={`navbtn ${active ? "navbtn-active" : ""}`} title={label} aria-label={label} onClick={onClick}>
      {icon}
    </button>
  );
}

export async function addProjectFlow(): Promise<void> {
  const folder = await window.ceo.desktop.pickFolder();
  if (!folder) return;
  const p = await act(() => call("addProject", { path: folder }));
  if (p) useStore.getState().toast(`Added ${p.name}`, "ok");
}

