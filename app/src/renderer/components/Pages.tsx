import { useEffect, useState } from "react";
import {
  ArchiveRestore, BarChart3, CheckCircle2, Users, CircleDollarSign, CircleX, Download, ExternalLink, Flag, FolderPlus, GitBranch, History, Link2, Plus, RefreshCw, ShieldCheck, ShieldAlert, Sparkles, Trophy,
} from "lucide-react";

import type { Insights, Race, Readiness, SpendReport, Workspace } from "../../shared/api";
import { call, desktop } from "../api";
import { ago, count, duration, mod, modelLabel, money, PROVIDER_LABEL, SHIFT } from "../format";
import { act, useStore } from "../store";
import { ProviderCard, SetupTerminal } from "./Dialogs";
import { addProjectFlow, StatusGlyph } from "./Sidebar";
import { Button, Empty, Kbd, ProviderMark, Select, Spinner, Stat } from "./ui";

function PageShell({ title, subtitle, actions, children }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="main">
      <header className="topbar drag page-top">
        <div className="top-left"><h1 className="top-title">{title}</h1>{subtitle && <span className="muted top-sub">{subtitle}</span>}</div>
        <div className="top-right no-drag">{actions}</div>
      </header>
      <div className="page"><div className="page-inner">{children}</div></div>
    </div>
  );
}

function Bars({ data }: { data: Array<{ day: string; costUsd: number }> }) {
  const max = Math.max(...data.map((d) => d.costUsd), 0.0001);
  const label = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <>
      <div className="bars" role="img" aria-label="Spend by day">
        {data.map((d) => (
          <div className="bar-col" key={d.day} title={`${label(d.day)}: ${money(d.costUsd)}`}>
            <div className="bar" style={{ height: `${Math.max(d.costUsd > 0 ? 3 : 0, (d.costUsd / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="bars-axis"><span>{label(data[0]!.day)}</span><span>Today</span></div>
    </>
  );
}

function ShareRow({ label, value, total, mark, runs, est }: { label: string; value: number; total: number; mark?: string; runs: number; est: boolean }) {
  return (
    <div className="share">
      <div className="share-top">
        {mark && <ProviderMark provider={mark} />}
        <span className="share-label" title={label}>{label}</span>
        <span className="muted">{runs} run{runs === 1 ? "" : "s"}</span>
        <b>{money(value)}{est ? " est." : ""}</b>
      </div>
      <div className="meter meter-fill"><span style={{ width: `${total > 0 ? (value / total) * 100 : 0}%` }} /></div>
    </div>
  );
}

export function SpendPage() {
  const projects = useStore((s) => s.snapshot.projects);
  const license = useStore((s) => s.license);
  const [days, setDays] = useState("30");
  const [pid, setPid] = useState("all");
  const [r, setR] = useState<SpendReport | null>(null);
  useEffect(() => {
    void act(() => call("spend", { projectId: pid === "all" ? null : pid, days: Number(days) })).then((x) => x && setR(x));
  }, [days, pid]);
  const exportIt = async (): Promise<void> => {
    if (pid === "all") {
      useStore.getState().toast("Choose one project to export its ledger.", "info");
      return;
    }
    if (!license?.limits.exportData) {
      useStore.getState().open({ kind: "upgrade", reason: "Export is part of Pro." });
      return;
    }
    const to = await desktop.pickSavePath("ledger.jsonl");
    if (to) await act(() => call("exportLedger", { projectId: pid, to }), "Ledger exported");
  };
  return (
    <PageShell
      title="Spend"
      subtitle="Every run, from the ledger"
      actions={<>
        <Select<string> align="right" value={pid} label={pid === "all" ? "All projects" : projects.find((p) => p.id === pid)?.name} options={[{ value: "all", label: "All projects" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} onChange={setPid} />
        <Select<string> align="right" value={days} label={`${days} days`} options={["7", "30", "90"].map((d) => ({ value: d, label: `${d} days` }))} onChange={setDays} />
        <Button size="sm" icon={<Download size={13} />} onClick={() => void exportIt()}>Export</Button>
      </>}
    >
      {!r ? <div className="center"><Spinner size={18} /></div> : r.runs === 0 ? (
        <Empty icon={<CircleDollarSign size={20} />} title="No runs yet">Every run's model, permissions and cost lands here.</Empty>
      ) : (
        <>
          <div className="stats">
            <Stat label="Spend" value={money(r.totalUsd)} detail={r.estimatedUsd > 0 ? `${money(r.estimatedUsd)} estimated at list price` : "Reported by the CLIs"} />
            <Stat label="Runs" value={r.runs} detail={`${money(r.totalUsd / Math.max(r.runs, 1))} a run`} />
            <div className={`stat ${r.ledger.ok ? "" : "stat-bad"}`} data-testid="ledger-status">
              <span className="stat-label">Ledger</span>
              <span className="stat-value stat-icon">{r.ledger.ok ? <ShieldCheck size={18} className="ok" /> : <ShieldAlert size={18} className="del" />} {r.ledger.ok ? "Intact" : "Altered"}</span>
              <span className="stat-detail">{r.ledger.detail}</span>
            </div>
          </div>
          {r.estimatedUsd > 0 && <p className="muted small note">On a subscription plan, a run's real cost is the plan. Estimates price the tokens at list rates. That keeps providers comparable and budgets firm.</p>}
          <section className="card"><h3>By day</h3><Bars data={r.byDay} /></section>
          <div className="two">
            <section className="card"><h3>By agent</h3>{r.byProvider.map((x) => <ShareRow key={x.key} label={PROVIDER_LABEL[x.label as keyof typeof PROVIDER_LABEL] ?? x.label} mark={x.label} value={x.costUsd} total={r.totalUsd} runs={x.runs} est={x.estimate} />)}</section>
            <section className="card"><h3>By workspace</h3>{r.byWorkspace.slice(0, 8).map((x) => <ShareRow key={x.key} label={x.label} value={x.costUsd} total={r.totalUsd} runs={x.runs} est={x.estimate} />)}</section>
          </div>
          <section className="card">
            <h3>Recent runs</h3>
            <table className="table">
              <thead><tr><th>Workspace</th><th>Task</th><th>Model</th><th>Time</th><th className="num">Cost</th><th className="num">When</th></tr></thead>
              <tbody>
                {r.recent.slice(0, 30).map((x) => (
                  <tr key={x.id}>
                    <td>{x.workspace}</td>
                    <td className="cell-clip" title={x.task}>{x.task}</td>
                    <td><ProviderMark provider={x.provider} size={6} /> {modelLabel(x.model)}</td>
                    <td>{duration(x.durationMs)}</td>
                    <td className="num">{money(x.costUsd)}{x.estimate ? " est." : ""}</td>
                    <td className="num muted">{ago(x.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </PageShell>
  );
}

export function InsightsPage() {
  const license = useStore((s) => s.license);
  const open = useStore((s) => s.open);
  const [r, setR] = useState<Insights | null>(null);
  useEffect(() => {
    if (license?.limits.insights) void act(() => call("insights", { projectId: null })).then((x) => x && setR(x));
  }, [license?.limits.insights]);
  if (!license?.limits.insights) {
    return (
      <PageShell title="Insights">
        <Empty icon={<BarChart3 size={20} />} title="Insights is part of Pro" action={<Button tone="accent" onClick={() => open({ kind: "upgrade" })}>See Pro</Button>}>
          See which agent passes which kind of work in this repository, measured by real checks.
        </Empty>
      </PageShell>
    );
  }
  const kinds = [...new Set(r?.rows.map((x) => x.kind) ?? [])];
  return (
    <PageShell title="Insights" subtitle={r ? `${r.races} race${r.races === 1 ? "" : "s"}, ${r.decided} decided by a check` : undefined} actions={<Button size="sm" icon={<Flag size={13} />} onClick={() => open({ kind: "race" })}>Race agents</Button>}>
      {!r ? <div className="center"><Spinner size={18} /></div> : r.rows.length === 0 ? (
        <Empty icon={<BarChart3 size={20} />} title="No evidence yet" action={<Button tone="accent" icon={<Flag size={13} />} onClick={() => open({ kind: "race" })}>Start a race</Button>}>
          Each race adds a result per agent. Patterns show here after a few.
        </Empty>
      ) : kinds.map((k) => (
        <section className="card" key={k}>
          <h3 className="cap">{k}</h3>
          {r.rows.filter((x) => x.kind === k).map((x) => (
            <div className="insight" key={`${x.provider}${x.model}${x.source}`}>
              <ProviderMark provider={x.provider} />
              <span className="insight-name">{modelLabel(x.model)}</span>
              <span className="meter meter-fill insight-bar"><span style={{ width: `${x.passRate * 100}%` }} /></span>
              <b>{Math.round(x.passRate * 100)}%</b>
              <span className="muted insight-n">{x.passes} of {x.runs}</span>
              <span className="muted insight-c">{x.costPerPass != null ? `${money(x.costPerPass)} a pass` : ""}</span>
            </div>
          ))}
        </section>
      ))}
    </PageShell>
  );
}

export function HistoryPage() {
  const workspaces = useStore((s) => s.snapshot.workspaces);
  const projects = useStore((s) => s.snapshot.projects);
  const setPage = useStore((s) => s.setPage);
  const list = workspaces.filter((w) => w.status === "archived").sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return (
    <PageShell title="History" subtitle="Archived workspaces. Branches and chats are kept.">
      {list.length === 0 ? <Empty icon={<History size={20} />} title="Nothing archived">Archived workspaces can be restored from here, chat included.</Empty> : (
        <div className="card list-card">
          {list.map((w) => (
            <div className="list-row" key={w.id} data-testid={`history-${w.slug}`}>
              <button className="list-main" onClick={() => setPage({ kind: "workspace", id: w.id })}>
                <b>{w.title}</b>
                <small className="muted">{projects.find((p) => p.id === w.projectId)?.name} · {w.branch} · {money(w.spentUsd)} · archived {ago(w.archivedAt ?? 0)} ago</small>
              </button>
              <Button size="sm" icon={<ArchiveRestore size={13} />} onClick={() => void act(async () => { await call("restoreWorkspace", { id: w.id }); setPage({ kind: "workspace", id: w.id }); }, "Restored")}>Restore</Button>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}

const STATE_LABEL: Record<string, string> = { running: "Working", checking: "Finished", passed: "Passed", failed: "Failed", "no-check": "Finished", cancelled: "Stopped" };

export function RacePage({ race }: { race: Race }) {
  const workspaces = useStore((s) => s.snapshot.workspaces);
  const setPage = useStore((s) => s.setPage);
  const open = useStore((s) => s.open);
  const running = !race.settledAt;
  const best = race.winnerId;
  return (
    <PageShell
      title={<><Flag size={15} className="title-ic" /> {race.title}</>}
      subtitle={race.check ? <>Check: <code>{race.check}</code></> : "No check. Compare and choose."}
      actions={race.settledAt && race.check && !race.kept ? <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => void act(() => call("rerunRaceChecks", { raceId: race.id }))}>Run the check again</Button> : undefined}
    >
      <div className={`race-banner ${best ? "race-won" : running ? "" : "race-none"}`} data-testid="race-banner">
        {running ? <><Spinner size={14} /> {race.entries.filter((e) => e.state === "running").length} of {race.entries.length} agents still working</> : best ? <><Trophy size={16} /> {race.note}</> : <>{race.note}</>}
      </div>
      <div className="race-grid">
        {race.entries.map((e) => {
          const w = workspaces.find((x) => x.id === e.workspaceId);
          const won = race.winnerId === e.workspaceId;
          return (
            <section className={`race-card ${won ? "race-card-won" : ""}`} key={e.workspaceId} data-testid={`race-${e.provider}`}>
              <header>
                <ProviderMark provider={e.provider} size={10} />
                <div className="race-who"><b>{PROVIDER_LABEL[e.provider]}</b><small className="muted">{modelLabel(e.model)}</small></div>
                {won && <Trophy size={15} className="race-trophy" />}
              </header>
              <div className={`race-state race-${e.state}`}>
                {e.state === "running" || e.state === "checking" ? <Spinner size={11} /> : e.state === "passed" ? <CheckCircle2 size={13} /> : e.state === "failed" ? <CircleX size={13} /> : null}
                {e.state === "checking" ? e.detail : STATE_LABEL[e.state]}
              </div>
              {e.state === "failed" && <p className="race-detail" title={e.detail}>{e.detail}</p>}
              <dl className="race-stats">
                <div><dt>Cost</dt><dd>{money(e.costUsd)}</dd></div>
                <div><dt>Time</dt><dd>{e.durationMs ? duration(e.durationMs) : "…"}</dd></div>
                <div><dt>Change</dt><dd><em className="add">+{w?.git.added ?? e.added}</em> <em className="del">−{w?.git.removed ?? e.removed}</em></dd></div>
              </dl>
              <footer>
                <Button size="sm" onClick={() => setPage({ kind: "workspace", id: e.workspaceId })}>Open</Button>
                {race.settledAt && !race.kept && w?.status !== "archived" && (
                  <Button size="sm" tone={won ? "accent" : "default"} data-testid={`keep-${e.provider}`} onClick={() => open({ kind: "confirm", title: `Keep ${PROVIDER_LABEL[e.provider]}'s work?`, body: "The other agents' workspaces are archived. Their branches stay, and can be restored from History.", action: "Keep", run: () => void act(async () => { await call("keepWinner", { raceId: race.id, workspaceId: e.workspaceId }); setPage({ kind: "workspace", id: e.workspaceId }); }, "Kept") })}>Keep this</Button>
                )}
                {race.kept && race.winnerId === e.workspaceId && <span className="badge badge-open">Kept</span>}
              </footer>
            </section>
          );
        })}
      </div>
      <section className="card"><h3>Task</h3><p className="pre-wrap">{race.prompt}</p></section>
    </PageShell>
  );
}

function Tile({ w }: { w: Workspace }) {
  const setPage = useStore((s) => s.setPage);
  return (
    <button className="tile" onClick={() => setPage({ kind: "workspace", id: w.id })} data-testid={`tile-${w.slug}`}>
      <div className="tile-top"><StatusGlyph w={w} /><span className="tile-title">{w.title}</span></div>
      <div className="tile-sub">
        <ProviderMark provider={w.tabs[0]?.provider ?? "claude"} size={6} />
        <span>{w.activity === "running" ? "Working" : w.activity === "unread" ? "Ready for review" : w.pr ? `PR #${w.pr.number}` : w.git.files > 0 ? `${count(w.git.files, "file")} changed` : "No changes"}</span>
        <span className="spacer" />
        {w.git.files > 0 && <span><em className="add">+{w.git.added}</em> <em className="del">−{w.git.removed}</em></span>}
        <span className="muted">{money(w.spentUsd)}</span>
      </div>
    </button>
  );
}

export function HomePage() {
  const { workspaces, projects, races } = useStore((s) => s.snapshot);
  const open = useStore((s) => s.open);
  const setPage = useStore((s) => s.setPage);
  const active = workspaces.filter((w) => w.status !== "archived");
  const needs = active.filter((w) => w.activity === "unread" || w.activity === "error");
  const running = active.filter((w) => w.activity === "running" || w.activity === "queued");
  const rest = active.filter((w) => !needs.includes(w) && !running.includes(w));
  const today = workspaces.reduce((n, w) => n + w.spentUsd, 0);
  return (
    <PageShell
      title="Home"
      subtitle={`${running.length} running · ${needs.length} waiting on review · ${money(today)} spent`}
      actions={<>
        <Button size="sm" icon={<Sparkles size={13} />} onClick={() => open({ kind: "plan" })}>Plan</Button>
        <Button size="sm" icon={<Flag size={13} />} onClick={() => open({ kind: "race" })}>Race</Button>
        <Button size="sm" tone="accent" icon={<Plus size={13} />} onClick={() => open({ kind: "new-workspace" })}>New workspace</Button>
      </>}
    >
      {active.length === 0 ? (
        <Empty icon={<GitBranch size={22} />} title="Start a workspace" action={<Button tone="accent" icon={<Plus size={13} />} onClick={() => open({ kind: "new-workspace" })} data-testid="home-new">New workspace <Kbd>{mod(SHIFT)}N</Kbd></Button>}>
          Each task gets its own branch and working copy, so several agents can work at once in {projects[0]?.name ?? "a project"}.
        </Empty>
      ) : (
        <>
          {needs.length > 0 && <TileGroup title="Waiting on review" list={needs} />}
          {running.length > 0 && <TileGroup title="Running" list={running} />}
          {rest.length > 0 && <TileGroup title="Idle" list={rest} />}
        </>
      )}
      <TeamsGroup />
      {races.length > 0 && (
        <section className="home-group">
          <h3>Races</h3>
          <div className="card list-card">
            {races.slice(0, 5).map((r) => (
              <button className="list-row list-main-row" key={r.id} onClick={() => setPage({ kind: "race", id: r.id })}>
                <Flag size={13} className="muted" /><b>{r.title}</b><small className="muted">{r.settledAt ? r.note : "Running"}</small>
              </button>
            ))}
          </div>
        </section>
      )}
    </PageShell>
  );
}
function TeamsGroup() {
  const { projects, org } = useStore((s) => s.snapshot);
  const setPage = useStore((s) => s.setPage);
  const git = projects.filter((p) => p.isGit);
  if (!git.length) return null;
  return (
    <section className="home-group">
      <h3>Teams</h3>
      <div className="tiles">
        {git.map((p) => {
          const o = org[p.id];
          const bits = [o?.hasChief ? "Chief of staff" : null, o?.agents ? `${o.agents} agent${o.agents === 1 ? "" : "s"}` : null, o?.queued ? `${o.queued} queued` : null, o?.approvals ? `${o.approvals} to approve` : null].filter(Boolean);
          return (
            <button key={p.id} className="tile" onClick={() => setPage({ kind: "org", projectId: p.id, tab: o?.hasChief ? "chief" : "team" })} data-testid={`home-team-${p.name}`}>
              <div className="tile-top">{o?.running ? <Spinner size={11} /> : <Users size={13} className="muted" />}<span className="tile-title">{p.name}</span></div>
              <div className="tile-sub">{o?.running ? `${o.running} working now` : bits.length ? bits.join(" · ") : "Hire a chief of staff or an agent"}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function TileGroup({ title, list }: { title: string; list: Workspace[] }) {
  return (
    <section className="home-group">
      <h3>{title}</h3>
      <div className="tiles">{list.map((w) => <Tile key={w.id} w={w} />)}</div>
    </section>
  );
}

export function Onboarding() {
  const readiness = useStore((s) => s.readiness);
  const projects = useStore((s) => s.snapshot.projects);
  const refresh = useStore((s) => s.refreshReadiness);
  const save = useStore((s) => s.saveSettings);
  const open = useStore((s) => s.open);
  const [term, setTerm] = useState<Readiness | null>(null);
  const [cloning, setCloning] = useState(false);
  const [url, setUrl] = useState("");
  const anyReady = readiness.some((r) => r.ready);
  const hasProject = projects.length > 0;
  const step = !anyReady ? 1 : !hasProject ? 2 : 3;
  useEffect(() => {
    if (!anyReady) {
      const t = setInterval(() => void refresh(true), 4000);
      return () => clearInterval(t);
    }
  }, [anyReady, refresh]);
  const clone = async (): Promise<void> => {
    const into = await desktop.pickFolder();
    if (!into) return;
    setCloning(true);
    await act(() => call("cloneProject", { url, into }), "Cloned");
    setCloning(false);
  };
  return (
    <div className="onboard drag" data-testid="onboarding">
      <div className="onboard-card no-drag">
        <div className="onboard-mark">CEO</div>
        <h1>Run a team of coding agents.</h1>
        <p className="onboard-lead">Each task gets its own branch. Review every change. Merge what works. No API key needed: agents run on the plans already signed in on this Mac.</p>

        <div className={`ostep ${step === 1 ? "ostep-on" : "ostep-done"}`}>
          <div className="ostep-head"><span className="ostep-n">{anyReady ? <CheckCircle2 size={16} /> : "1"}</span> <b>Connect an agent</b>{anyReady && <small className="muted">{readiness.filter((r) => r.ready).map((r) => PROVIDER_LABEL[r.provider]).join(", ")}</small>}</div>
          <div className="ostep-body">
            {readiness.map((r) => <ProviderCard key={r.provider} r={r} onTerminal={setTerm} />)}
          </div>
        </div>

        <div className={`ostep ${step === 2 ? "ostep-on" : step > 2 ? "ostep-done" : ""}`}>
          <div className="ostep-head"><span className="ostep-n">{hasProject ? <CheckCircle2 size={16} /> : "2"}</span> <b>Add a project</b>{hasProject && <small className="muted">{projects[0]!.name}</small>}</div>
          {step === 2 && (
            <div className="ostep-body">
              <Button tone="accent" icon={<FolderPlus size={14} />} onClick={() => void addProjectFlow()} data-testid="onboard-add">Choose a folder</Button>
              <div className="clone-row">
                <Link2 size={13} className="muted" />
                <input className="input" value={url} placeholder="Or clone: https://github.com/owner/repo" onChange={(e) => setUrl(e.target.value)} />
                <Button disabled={!url.trim() || cloning} icon={cloning ? <Spinner size={12} /> : <ExternalLink size={12} />} onClick={() => void clone()}>Clone</Button>
              </div>
            </div>
          )}
        </div>

        <div className={`ostep ${step === 3 ? "ostep-on" : ""}`}>
          <div className="ostep-head"><span className="ostep-n">3</span> <b>Start a workspace</b></div>
          {step === 3 && (
            <div className="ostep-body">
              <Button tone="accent" icon={<Plus size={14} />} data-testid="onboard-start" onClick={() => { void save({ onboarded: true }); open({ kind: "new-workspace" }); }}>New workspace</Button>
            </div>
          )}
        </div>
      </div>
      {term && <SetupTerminal r={term} onClose={() => setTerm(null)} />}
    </div>
  );
}
