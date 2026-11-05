import { useEffect, useState } from "react";
import {
  Archive, ArchiveRestore, ChevronRight, Copy, ExternalLink, FolderOpen, GitBranch, GitPullRequest, MoreHorizontal, PanelRight, Play, RefreshCw, Square, Trash2, Trophy, Wallet,
} from "lucide-react";

import type { Workspace } from "../../shared/api";
import { call, desktop } from "../api";
import { money, shortBase } from "../format";
import { act, useStore } from "../store";
import { Chat } from "./Chat";
import { Inspector, runNextAction, useChecks } from "./Inspector";
import { Review } from "./Review";
import { Button, Menu, Resizer, Spinner } from "./ui";

const EDITORS = ["Cursor", "Visual Studio Code", "Zed", "Xcode", "Terminal", "iTerm"];

function Title({ w }: { w: Workspace }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(w.title);
  useEffect(() => setValue(w.title), [w.title]);
  if (editing) {
    return (
      <input
        className="title-input no-drag"
        autoFocus
        value={value}
        aria-label="Workspace title"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { setEditing(false); void act(() => call("renameWorkspace", { id: w.id, title: value })); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setValue(w.title); setEditing(false); } }}
      />
    );
  }
  return <h1 className="top-title no-drag" title="Double-click to rename" onDoubleClick={() => setEditing(true)}>{w.title}</h1>;
}

function PrimaryAction({ w }: { w: Workspace }) {
  const { report } = useChecks(w, w.status === "ready");
  if (!report || report.next === "start") return null;
  if (report.next === "wait") return <span className="top-wait"><Spinner size={11} /> {report.nextLabel}</span>;
  const prView = report.pr && report.next !== "merge";
  return (
    <>
      {prView && <Button size="sm" icon={<GitPullRequest size={13} />} onClick={() => void desktop.openExternal(report.pr!.url)}>#{report.pr!.number}</Button>}
      <Button tone="accent" size="sm" onClick={() => runNextAction(w, report)} title={report.nextDetail} data-testid="primary-action">{report.nextLabel}</Button>
    </>
  );
}

function TopBar({ w }: { w: Workspace }) {
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === w.projectId));
  const race = useStore((s) => s.snapshot.races.find((r) => r.id === w.raceId));
  const setPage = useStore((s) => s.setPage);
  const setInspector = useStore((s) => s.setInspector);
  const toggleInspector = useStore((s) => s.toggleInspector);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const open = useStore((s) => s.open);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const archived = w.status === "archived";
  const openIn = (app: string): void => {
    void saveSettings({ editor: app });
    void desktop.openPath(w.worktree, app).then((err) => err && useStore.getState().toast(err, "error"));
  };
  return (
    <header className="topbar drag">
      <div className="top-left">
        <span className="crumb no-drag" title={project?.path}>{project?.name}</span>
        <ChevronRight size={12} className="muted" />
        <Title w={w} />
        <span className="branch no-drag" title={`${w.branch} from ${w.baseRef}`}>
          <GitBranch size={11} /> {w.branch} <span className="muted">from {shortBase(w.baseRef)}</span>
        </span>
        {race && (
          <button className="branch branch-race no-drag" onClick={() => setPage({ kind: "race", id: race.id })}><Trophy size={11} /> Race</button>
        )}
      </div>
      <div className="top-right no-drag">
        {!archived && <PrimaryAction w={w} />}
        {archived ? (
          <Button tone="accent" size="sm" icon={<ArchiveRestore size={13} />} onClick={() => void act(() => call("restoreWorkspace", { id: w.id }), "Restored")} data-testid="restore">Restore</Button>
        ) : (
          <>
            {w.scripts.run ? (
              <Button size="sm" icon={<Square size={11} fill="currentColor" />} onClick={() => void act(() => call("stopScript", { id: w.id, kind: "run" }))}>Stop</Button>
            ) : (
              <Button size="sm" icon={<Play size={12} />} data-testid="run-btn" onClick={() => {
                setInspector("run");
                if (project?.config.run.trim()) void act(() => call("runScript", { id: w.id, kind: "run" }));
              }}>Run</Button>
            )}
            <Menu
              align="right"
              trigger={(_o, t) => <Button size="sm" icon={<ExternalLink size={13} />} onClick={t}>Open</Button>}
              items={[
                ...(settings?.editor ? [{ label: settings.editor, detail: "Last used", onClick: () => openIn(settings.editor) }, { separator: true, label: "" }] : []),
                ...EDITORS.filter((e) => e !== settings?.editor).map((e) => ({ label: e, onClick: () => openIn(e) })),
                { separator: true, label: "" },
                { icon: <FolderOpen size={13} />, label: "Finder", onClick: () => void desktop.openPath(w.worktree) },
                { icon: <Copy size={13} />, label: "Copy path", onClick: () => void desktop.copy(w.worktree) },
              ]}
            />
          </>
        )}
        <Menu
          align="right"
          trigger={(_o, t) => <Button size="sm" tone="ghost" icon={<MoreHorizontal size={15} />} onClick={t} aria-label="Workspace menu" data-testid="ws-menu" />}
          items={[
            ...(!archived
              ? [
                  { icon: <RefreshCw size={13} />, label: `Update from ${shortBase(w.baseRef)}`, onClick: () => void act(async () => { const r = await call("updateFromBase", { id: w.id }); useStore.getState().toast(r.conflicts.length ? `${r.conflicts.length} files conflict. Ask the agent to resolve them.` : "Up to date", r.conflicts.length ? "error" : "ok"); }) },
                  {
                    icon: <Wallet size={13} />, label: `Budget: ${money(w.spentUsd)} of ${money(w.budgetUsd)}`, detail: "Raise by $25",
                    onClick: () => void act(() => call("setBudget", { id: w.id, budgetUsd: w.budgetUsd + 25 }), "Budget raised by $25"),
                  },
                  { icon: <Archive size={13} />, label: "Archive", onClick: () => void act(() => call("archiveWorkspace", { id: w.id }), `Archived ${w.title}`) },
                  { separator: true, label: "" },
                ]
              : []),
            {
              icon: <Trash2 size={13} />, label: "Delete", danger: true,
              onClick: () => open({ kind: "confirm", title: `Delete ${w.title}?`, body: `${w.git.ahead > 0 && !w.mergedAt ? `${w.git.ahead} commit${w.git.ahead === 1 ? " is" : "s are"} on this branch and not merged. ` : ""}The branch ${w.branch}, its worktree and this chat are removed. The ledger keeps its record of the spend. This cannot be undone.`, action: "Delete", danger: true, run: () => void act(async () => { await call("deleteWorkspace", { id: w.id }); setPage({ kind: "home" }); }) }),
            },
          ]}
        />
        <Button size="sm" tone="ghost" aria-label="Toggle inspector" className={inspectorOpen ? "tog-on" : ""} icon={<PanelRight size={15} />} onClick={toggleInspector} />
      </div>
    </header>
  );
}

export function WorkspaceView({ w }: { w: Workspace }) {
  const review = useStore((s) => s.review);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const width = useStore((s) => s.inspectorWidth);
  const setWidths = useStore((s) => s.setWidths);
  if (review) return <div className="main"><Review w={w} /></div>;
  return (
    <div className="main">
      <TopBar w={w} />
      {(w.status === "creating" || w.status === "setup") && <div className="banner" data-testid="banner-creating"><Spinner size={11} /> {w.statusDetail ?? "Preparing"}. Messages sent now start when this finishes.</div>}
      {w.status === "failed" && (
        <div className="banner banner-warn" data-testid="banner-failed">
          {w.statusDetail ?? "This workspace could not start."}
          <button className="link" data-testid="recreate" onClick={() => void act(() => call("restoreWorkspace", { id: w.id }), "Worktree recreated")}>Recreate the worktree</button>
        </div>
      )}
      {w.status === "archiving" && <div className="banner"><Spinner size={11} /> Archiving</div>}
      {w.status === "ready" && w.statusDetail && <div className="banner banner-warn">{w.statusDetail}. <button className="link" onClick={() => useStore.getState().setInspector("run")}>See the log</button></div>}
      <div className="workspace">
        <Chat w={w} />
        {inspectorOpen && (
          <div className="insp-wrap" style={{ width }}>
            <Resizer side="left" onDrag={(x) => setWidths({ inspectorWidth: Math.min(Math.max(window.innerWidth - x, 300), window.innerWidth * 0.6) })} />
            <Inspector w={w} />
          </div>
        )}
      </div>
    </div>
  );
}
