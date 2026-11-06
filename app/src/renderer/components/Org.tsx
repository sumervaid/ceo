import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp, BadgeCheck, Bot, Building2, Check, ChevronRight, CircleDollarSign, Crown, FileText, GitBranch, GitMerge, Github, HelpCircle, Inbox, ListPlus, ListTodo,
  Megaphone, MessageSquare, MoreHorizontal, Orbit, Play, Plus, Radio, RefreshCw, RotateCcw, Send, ShieldAlert, ShieldCheck, Sparkles, Square, Target, Trash2,
  UserMinus, UserPlus, Users, Wrench, X, Box, BookOpen,
} from "lucide-react";

import type { Agent, AgentDetail, Approval, Chief, ChiefTurn, DocketItem, Integrations, Org, OrgRun, Provider, RunLine, Task, TaskState } from "../../shared/api";
import { call } from "../api";
import { ago, duration, modelLabel, money, PROVIDER_LABEL } from "../format";
import { renderMarkdown } from "../markdown";
import { act, useStore, type OrgTab } from "../store";
import { LevelPicker, LEVEL_HINT, LEVEL_NAME, useTeam } from "./OrgDialogs";
import { Button, Empty, Field, Menu, ProviderMark, Select, Spinner, Stat } from "./ui";

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function Avatar({ name, provider, size = 28, live }: { name: string; provider: Provider | string; size?: number; live?: boolean }) {
  return (
    <span className={`avatar avatar-${provider} ${live ? "avatar-live" : ""}`} style={{ width: size, height: size, fontSize: size * 0.38 }} title={`${name} · ${PROVIDER_LABEL[provider as Provider] ?? provider}`}>
      {name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()}
    </span>
  );
}

function useOrg(projectId: string): Org | undefined {
  const org = useStore((s) => s.orgs[projectId]);
  const loadOrg = useStore((s) => s.loadOrg);
  useEffect(() => {
    void loadOrg(projectId);
  }, [projectId, loadOrg]);
  return org;
}

const TABS: Array<{ id: OrgTab; label: string; icon: ReactNode }> = [
  { id: "chief", label: "Chief of staff", icon: <Crown size={13} /> },
  { id: "team", label: "Team", icon: <Users size={13} /> },
  { id: "tasks", label: "Tasks", icon: <ListTodo size={13} /> },
  { id: "live", label: "Live", icon: <Radio size={13} /> },
  { id: "map", label: "Map", icon: <Orbit size={13} /> },
  { id: "approvals", label: "Approvals", icon: <Inbox size={13} /> },
  { id: "docket", label: "Docket", icon: <BookOpen size={13} /> },
  { id: "mission", label: "Mission", icon: <Target size={13} /> },
  { id: "integrations", label: "Integrations", icon: <Box size={13} /> },
];

export function OrgPage({ projectId, tab, agent }: { projectId: string; tab: OrgTab; agent?: string | null }) {
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === projectId));
  const setPage = useStore((s) => s.setPage);
  const open = useStore((s) => s.open);
  const org = useOrg(projectId);
  const go = (t: OrgTab, a: string | null = null): void => setPage({ kind: "org", projectId, tab: t, agent: a });
  if (!project) return null;
  const running = org?.runs.filter((r) => r.status === "running").length ?? 0;
  const counts: Partial<Record<OrgTab, number>> = {
    approvals: org?.approvals.length ?? 0,
    live: running,
    tasks: org?.tasks.filter((t) => t.status === "queued" || t.status === "running" || t.status === "verifying").length ?? 0,
  };
  return (
    <div className="main org" data-testid="org-page">
      <header className="topbar drag">
        <div className="top-left">
          <Users size={14} className="muted" />
          <h1 className="top-title">{project.name}</h1>
          <span className="muted top-sub">{org ? `${org.agents.filter((a) => !a.workspaceId).length} agents · ${money(org.spentTodayUsd)} today` : ""}</span>
        </div>
        <div className="top-right no-drag">
          <Button size="sm" icon={<ListPlus size={13} />} onClick={() => open({ kind: "task", projectId })} data-testid="org-new-task">New task</Button>
          <Button size="sm" tone="accent" icon={<UserPlus size={13} />} onClick={() => open({ kind: "hire", projectId })} data-testid="org-hire">Hire</Button>
        </div>
      </header>
      <nav className="tabs org-tabs no-drag" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "tab-on" : ""}`} onClick={() => go(t.id)} data-testid={`org-tab-${t.id}`}>
            {t.id === "live" && running > 0 ? <Spinner size={10} /> : t.icon}
            <span>{t.label}</span>
            {!!counts[t.id] && t.id !== "live" && <em className={`tab-count ${t.id === "approvals" ? "tab-count-warn" : ""}`}>{counts[t.id]}</em>}
          </button>
        ))}
      </nav>
      {!org ? <div className="center"><Spinner size={18} /></div> : !project.isGit ? (
        <Empty icon={<Users size={20} />} title="A team needs a git repository">Agents work on branches. Initialize git in this folder first.</Empty>
      ) : (
        <div className="org-body">
          {org.error && <div className="banner banner-warn">{org.error}</div>}
          {tab === "chief" && <ChiefTab org={org} go={go} />}
          {tab === "team" && <TeamTab org={org} agent={agent ?? null} go={go} />}
          {tab === "tasks" && <TasksTab org={org} go={go} />}
          {tab === "live" && <LiveTab org={org} />}
          {tab === "map" && <MapTab org={org} go={go} />}
          {tab === "approvals" && <ApprovalsTab org={org} />}
          {tab === "docket" && <DocketTab org={org} />}
          {tab === "mission" && <MissionTab org={org} />}
          {tab === "integrations" && <IntegrationsTab org={org} />}
        </div>
      )}
    </div>
  );
}

// -- run output -------------------------------------------------------------

type Block = { kind: "tools"; lines: RunLine[] } | RunLine;
function blocks(lines: RunLine[]): Block[] {
  const out: Block[] = [];
  for (const l of lines) {
    if (l.kind === "tool" || l.kind === "denied") {
      const last = out[out.length - 1];
      if (last && last.kind === "tools") last.lines.push(l);
      else out.push({ kind: "tools", lines: [l] });
    } else out.push(l);
  }
  return out;
}

function ToolLines({ lines, running }: { lines: RunLine[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const denied = lines.filter((l) => l.kind === "denied").length;
  const last = lines[lines.length - 1]!;
  return (
    <div className="tools">
      <button className="tools-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={open ? "rot90" : ""} />
        {running ? <Spinner size={11} /> : <Wrench size={12} />}
        <span className="tools-count">{lines.length} {lines.length === 1 ? "action" : "actions"}</span>
        {denied > 0 && <span className="tools-denied"><ShieldAlert size={11} /> {denied} blocked</span>}
        {!open && <span className="tools-last">{last.text}</span>}
      </button>
      {open && (
        <ul className="tools-list">
          {lines.map((l, i) => (l.kind === "tool" ? <li key={i}>{l.text}</li> : <li key={i} className="tools-denied-row"><ShieldAlert size={11} /> <b>{l.text}</b> blocked by this agent's permissions</li>))}
        </ul>
      )}
    </div>
  );
}

export function RunFeed({ run, onlyText }: { run: OrgRun; onlyText?: boolean }) {
  const bs = blocks(run.lines);
  const running = run.status === "running";
  return (
    <div className="feed">
      {bs.map((b, i) => {
        if (b.kind === "tools") return onlyText ? null : <ToolLines key={i} lines={b.lines} running={running && i === bs.length - 1} />;
        if (b.kind === "text") return <Markdown key={i} text={b.text} />;
        if (b.kind === "turn") return <div key={i} className="msg-system">Next turn: {b.text}</div>;
        if (b.kind === "error") return <div key={i} className="result-error"><p>{b.text}</p></div>;
        return null;
      })}
      {running && bs.length === 0 && <div className="msg-thinking"><Spinner size={11} /> Starting</div>}
    </div>
  );
}

function RunStatus({ run }: { run: OrgRun }) {
  if (run.status === "running") return <span className="rstate rstate-running"><Spinner size={10} /> {duration(Date.now() - run.startedAt)}</span>;
  const label = { done: "Done", failed: "Failed", cancelled: "Stopped", waiting: "Provider limit" }[run.status];
  return <span className={`rstate rstate-${run.status}`}>{label}</span>;
}

// -- the chief of staff -----------------------------------------------------

const STARTERS = [
  "What is everyone working on right now?",
  "Staff a small team to add tests for the least tested module.",
  "Review the open branches and say which are ready to merge.",
];

function ActionCard({ a, org, go }: { a: ChiefTurn["actions"][number]; org: Org; go: (t: OrgTab, agent?: string | null) => void }) {
  const icon = { hire: <UserPlus size={13} />, delegate: <Send size={13} />, handoff: <ListPlus size={13} />, fire: <UserMinus size={13} />, post: <MessageSquare size={13} />, ask: <HelpCircle size={13} />, budget: <CircleDollarSign size={13} /> }[a.kind];
  const verb = { hire: "Hired", delegate: "Gave work to", handoff: "Queued for", fire: "Fired", post: "Note to", ask: "Asked", budget: "Budget for" }[a.kind];
  const task = a.taskId ? org.tasks.find((t) => t.id === a.taskId) : null;
  const agent = org.agents.find((x) => x.name === a.agent);
  return (
    <button className={`action action-${a.kind}`} onClick={() => (task ? go("live") : agent ? go("team", agent.name) : undefined)} data-testid={`chief-action-${a.kind}`}>
      <span className="action-icon">{icon}</span>
      <span className="action-main">
        <span className="action-top">
          {verb} {agent ? <Avatar name={agent.name} provider={agent.provider} size={16} /> : null}<b>{a.agent === "*" ? "everyone" : a.agent}</b>
          {a.provider && a.kind === "hire" && <span className="muted small">on {PROVIDER_LABEL[a.provider]}</span>}
        </span>
        {a.text && <span className="action-text">{a.text}</span>}
      </span>
      {task && <TaskBadge status={task.status} />}
    </button>
  );
}

function TaskBadge({ status }: { status: TaskState }) {
  const label: Record<TaskState, string> = { queued: "Queued", running: "Running", verifying: "Checking", done: "Done", failed: "Failed", cancelled: "Cancelled", blocked: "Blocked" };
  return <span className={`tbadge tbadge-${status}`}>{status === "running" || status === "verifying" ? <Spinner size={9} /> : null}{label[status]}</span>;
}

function ChiefTranscript({ chief, org, go }: { chief: Chief; org: Org; go: (t: OrgTab, agent?: string | null) => void }) {
  const live = chief.replying ? org.runs.find((r) => r.key === chief.replying) : null;
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const size = chief.turns.length + (live?.lines.length ?? 0) + (live?.lines.at(-1)?.text.length ?? 0);
  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [size]);
  return (
    <div className="transcript" ref={ref} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }} data-testid="chief-transcript">
      <div className="transcript-inner">
        {chief.turns.length === 0 && !live && (
          <div className="chief-hello">
            <Crown size={22} className="accent" />
            <h2>{chief.name} runs the team</h2>
            <p className="muted">Describe the outcome. The chief of staff picks or hires the right agents, writes each task with a definition of done and starts the work.</p>
            <div className="starters">
              {STARTERS.map((s) => <button key={s} className="starter" onClick={() => void act(() => call("chiefSend", { projectId: org.projectId, text: s }))}>{s}</button>)}
            </div>
          </div>
        )}
        {chief.turns.map((t) => {
          const streaming = t.status === "running" && live;
          return (
            <div key={t.id} className="turn">
              <div className="msg-user"><div className="msg-user-text">{t.message}</div></div>
              {streaming ? <RunFeed run={live} /> : t.reply ? <div className="msg-agent"><Markdown text={t.reply} /></div> : t.status === "running" ? <div className="msg-thinking"><Spinner size={11} /> Thinking</div> : null}
              {t.actions.length > 0 && <div className="actions">{t.actions.map((a, i) => <ActionCard key={i} a={a} org={org} go={go} />)}</div>}
              {t.status !== "running" && (
                <div className="result-meta">
                  {t.provider && <span><ProviderMark provider={t.provider} size={6} /> {modelLabel(t.model ?? "")}</span>}
                  <span>{money(t.costUsd)}{t.estimate ? " est." : ""}</span>
                  {t.status === "failed" && <span className="del">The reply failed</span>}
                  {t.status === "cancelled" && <span>Stopped</span>}
                  <span>{ago(t.ts)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChiefComposer({ org, chief }: { org: Org; chief: Chief }) {
  const draft = useStore((s) => s.drafts[`chief:${org.projectId}`]?.text ?? "");
  const setDraft = useStore((s) => s.setDraft);
  const ref = useRef<HTMLTextAreaElement>(null);
  const replying = !!chief.replying;
  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || replying) return;
    const ok = await act(async () => { await call("chiefSend", { projectId: org.projectId, text }); return true; });
    if (ok) setDraft(`chief:${org.projectId}`, { text: "" });
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          autoFocus
          data-testid="chief-input"
          placeholder={replying ? `${chief.name} is replying. The next message waits for the reply.` : `Tell ${chief.name} what needs doing`}
          onChange={(e) => setDraft(`chief:${org.projectId}`, { text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bar">
          <span className="composer-budget">{chief.may.start ? "Starts the work it gives out" : chief.may.queue ? "Queues work for review" : "Answers only"}</span>
          <span className="composer-spacer" />
          {replying ? (
            <Button size="sm" tone="default" icon={<Square size={11} />} onClick={() => void call("chiefStop", { projectId: org.projectId })} data-testid="chief-stop">Stop</Button>
          ) : (
            <Button size="sm" tone="primary" icon={<ArrowUp size={14} />} disabled={!draft.trim()} onClick={() => void send()} aria-label="Send" data-testid="chief-send" />
          )}
        </div>
      </div>
    </div>
  );
}

function ChiefRail({ org, chief, go }: { org: Org; chief: Chief; go: (t: OrgTab, agent?: string | null) => void }) {
  const readiness = useStore((s) => s.readiness);
  const [allowance, setAllowance] = useState(String(chief.allowance.totalUsd));
  useEffect(() => setAllowance(String(chief.allowance.totalUsd)), [chief.allowance.totalUsd]);
  const set = (p: Parameters<typeof call<"chiefSet">>[1]): void => void act(() => call("chiefSet", p));
  const team = org.agents.filter((a) => !a.chief && !a.workspaceId);
  const fromChief = org.tasks.filter((t) => t.requestedBy === chief.name).slice(-8).reverse();
  const models = readiness.find((r) => r.provider === chief.provider)?.models ?? [chief.model];
  return (
    <aside className="rail">
      <section className="rail-card">
        <div className="rail-head"><Avatar name={chief.name} provider={chief.provider} size={30} live={!!chief.replying} /><div><b>{chief.name}</b><small className="muted">Chief of staff</small></div></div>
        <div className="form-row">
          <Field label="Runs on">
            <Select<Provider> value={chief.provider} options={(["claude", "codex", "gemini"] as Provider[]).map((p) => ({ value: p, label: PROVIDER_LABEL[p], icon: <ProviderMark provider={p} />, disabled: !readiness.find((r) => r.provider === p)?.ready }))} onChange={(p) => set({ projectId: org.projectId, provider: p })} />
          </Field>
          <Field label="Model">
            <Select<string> value={chief.model} label={modelLabel(chief.model)} options={(models.includes(chief.model) ? models : [chief.model, ...models]).map((m) => ({ value: m, label: modelLabel(m) }))} onChange={(m) => set({ projectId: org.projectId, model: m })} />
          </Field>
        </div>
        <Field label="Authority" hint={`The chief ${chief.levelLabel}.`}>
          <LevelPicker value={chief.level} onChange={(l) => set({ projectId: org.projectId, level: l })} />
        </Field>
        <Field label="Allowance" hint={`${money(chief.allowance.leftUsd)} of ${money(chief.allowance.totalUsd)} left to give other agents.`}>
          <div className="allow">
            <div className="meter meter-fill"><span style={{ width: `${chief.allowance.totalUsd > 0 ? Math.min(100, (chief.allowance.givenUsd / chief.allowance.totalUsd) * 100) : 0}%` }} /></div>
            <input className="input allow-input" value={allowance} inputMode="decimal" aria-label="Allowance in dollars" onChange={(e) => setAllowance(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={() => Number(allowance) !== chief.allowance.totalUsd && set({ projectId: org.projectId, allowanceUsd: Number(allowance) || 0 })} />
          </div>
        </Field>
        <div className="rail-stats">
          <span><b>{money(chief.chiefCostUsd)}</b><small>Replies</small></span>
          <span><b>{money(chief.teamCostUsd)}</b><small>Team work</small></span>
          <span><b>{chief.teamRuns}</b><small>Runs</small></span>
        </div>
        <Button size="sm" tone="ghost" icon={<RotateCcw size={12} />} disabled={!!chief.replying || chief.turns.length === 0} onClick={() => void act(() => call("chiefNew", { projectId: org.projectId }))} data-testid="chief-new">New conversation</Button>
      </section>
      <section className="rail-card">
        <h3>Team</h3>
        {team.length === 0 && <p className="muted small">Nobody yet. The chief hires as work comes in.</p>}
        {team.map((a) => (
          <button key={a.name} className="mini-agent" onClick={() => go("team", a.name)}>
            <Avatar name={a.name} provider={a.provider} size={20} live={a.state === "running"} />
            <span className="mini-name">{a.name}</span>
            <span className="muted small mini-doing">{a.state === "running" ? a.doing : a.queued ? `${a.queued} queued` : LEVEL_NAME[a.level]}</span>
          </button>
        ))}
      </section>
      {fromChief.length > 0 && (
        <section className="rail-card">
          <h3>Work given out</h3>
          {fromChief.map((t) => (
            <button key={t.id} className="mini-task" onClick={() => go("tasks")}>
              <TaskBadge status={t.status} /><span className="mini-task-title" title={t.title}>{t.title}</span><span className="muted small">{t.assignee}</span>
            </button>
          ))}
        </section>
      )}
    </aside>
  );
}

function ChiefTab({ org, go }: { org: Org; go: (t: OrgTab, agent?: string | null) => void }) {
  const license = useStore((s) => s.license);
  const readiness = useStore((s) => s.readiness);
  const open = useStore((s) => s.open);
  const [provider, setProvider] = useState<Provider>(readiness.find((r) => r.ready)?.provider ?? "claude");
  const chief = org.chief;
  if (!chief) {
    return (
      <div className="page"><div className="page-inner">
        <div className="hero" data-testid="chief-hero">
          <div className="hero-mark"><Crown size={22} /></div>
          <h2>A chief of staff for this repository</h2>
          <p className="muted">One conversation runs the whole team. The chief reads the roster, the board and every output. Then it hires the right agent on the right provider, writes each task with a definition of done and starts the work.</p>
          <ul className="hero-list">
            <li><Check size={13} /> Staffs work across Claude, Codex and Gemini</li>
            <li><Check size={13} /> Spends from an allowance set here, never more</li>
            <li><Check size={13} /> Its own process is read-only. The team does the work.</li>
          </ul>
          {license?.limits.chief ? (
            <div className="hero-actions">
              <Select<Provider> value={provider} options={(["claude", "codex", "gemini"] as Provider[]).map((p) => ({ value: p, label: PROVIDER_LABEL[p], icon: <ProviderMark provider={p} />, disabled: !readiness.find((r) => r.provider === p)?.ready }))} onChange={setProvider} />
              <Button tone="accent" size="lg" icon={<Crown size={14} />} onClick={() => void act(() => call("hireChief", { projectId: org.projectId, provider }), "Chief of staff hired")} data-testid="hire-chief">Hire a chief of staff</Button>
            </div>
          ) : (
            <Button tone="accent" size="lg" onClick={() => open({ kind: "upgrade", reason: "The chief of staff is part of Pro." })}>Get Pro</Button>
          )}
          <p className="muted small">Or start a whole company at once. <button className="link" onClick={() => open({ kind: "company", projectId: org.projectId })}>Choose a team</button></p>
        </div>
      </div></div>
    );
  }
  return (
    <div className="chief">
      <div className="chat">
        <ChiefTranscript chief={chief} org={org} go={go} />
        <ChiefComposer org={org} chief={chief} />
      </div>
      <ChiefRail org={org} chief={chief} go={go} />
    </div>
  );
}

// -- team -------------------------------------------------------------------

function AgentCard({ a, projectId, onOpen }: { a: Agent; projectId: string; onOpen: () => void }) {
  const open = useStore((s) => s.open);
  const pct = a.budgetUsd > 0 ? Math.min(100, (a.spentUsd / a.budgetUsd) * 100) : 0;
  return (
    <div className={`acard ${a.state === "running" ? "acard-live" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()} data-testid={`agent-${a.name}`}>
      <div className="acard-top">
        <Avatar name={a.name} provider={a.provider} size={32} live={a.state === "running"} />
        <div className="acard-id">
          <b>{a.name}</b>
          <span className="muted small"><ProviderMark provider={a.provider} size={6} /> {PROVIDER_LABEL[a.provider]} · {modelLabel(a.model)}</span>
        </div>
        <span className={`level level-${a.level}`} title={LEVEL_HINT[a.level]}>{LEVEL_NAME[a.level]}</span>
      </div>
      <p className="acard-role">{a.role}</p>
      <div className="acard-state">
        {a.state === "running" ? <><Spinner size={10} /><span className="clip">{a.doing}</span></>
          : a.state === "over-budget" ? <span className="warn">Budget spent</span>
          : a.state === "waiting" ? <span className="warn">Waiting on a provider limit</span>
          : <span className="muted">Idle{a.queued ? ` · ${a.queued} queued` : ""}</span>}
      </div>
      <div className="acard-foot">
        <span className="acard-budget" title={a.budgetUsd > 0 ? `${money(a.spentUsd)} of ${money(a.budgetUsd)}` : "No cap"}>
          <span className="meter"><span style={{ width: `${pct}%` }} /></span>
          {money(a.spentUsd)}{a.budgetUsd > 0 ? ` / ${money(a.budgetUsd)}` : ""}
        </span>
        {a.branch && <span className="chip"><GitBranch size={10} /><span className="chip-text">{a.branch}</span></span>}
        <span className="spacer" />
        <Button size="sm" tone="ghost" icon={<Send size={12} />} onClick={(e) => { e.stopPropagation(); open({ kind: "delegate", projectId, agent: a.name }); }} aria-label={`Give ${a.name} work`} data-testid={`give-${a.name}`} />
      </div>
    </div>
  );
}

function TeamTab({ org, agent, go }: { org: Org; agent: string | null; go: (t: OrgTab, agent?: string | null) => void }) {
  const open = useStore((s) => s.open);
  const team = useTeam(org.projectId);
  const wsAgents = org.agents.filter((a) => a.workspaceId);
  const setPage = useStore((s) => s.setPage);
  return (
    <div className="split">
      <div className="page"><div className="page-inner">
        <div className="toolbar">
          <Menu
            trigger={(_o, t) => <Button tone="accent" icon={<UserPlus size={13} />} onClick={t} data-testid="team-hire-menu">Add to the team</Button>}
            items={[
              { icon: <UserPlus size={14} />, label: "Hire an agent", detail: "A brief, a provider, a budget and a level", onClick: () => open({ kind: "hire", projectId: org.projectId }) },
              { icon: <Building2 size={14} />, label: "Start a company", detail: "A whole team at once, on several providers", onClick: () => open({ kind: "company", projectId: org.projectId }) },
              { icon: <Sparkles size={14} />, label: "Suggest a team", detail: "From this repository and recent sessions", onClick: () => open({ kind: "suggest", projectId: org.projectId }) },
            ]}
          />
          <Button icon={<Send size={13} />} disabled={!team.length} onClick={() => open({ kind: "delegate", projectId: org.projectId })}>Give work</Button>
          <Button icon={<Megaphone size={13} />} disabled={team.length < 2} onClick={() => open({ kind: "broadcast", projectId: org.projectId })}>Broadcast</Button>
          <span className="spacer" />
          {org.chief && <button className="link small" onClick={() => go("chief")}><Crown size={12} /> {org.chief.name} {org.chief.replying ? "is replying" : "runs this team"}</button>}
        </div>
        {team.length === 0 ? (
          <Empty icon={<Users size={20} />} title="No team yet" action={<div className="hero-actions"><Button tone="accent" icon={<UserPlus size={13} />} onClick={() => open({ kind: "hire", projectId: org.projectId })}>Hire an agent</Button><Button icon={<Building2 size={13} />} onClick={() => open({ kind: "company", projectId: org.projectId })}>Start a company</Button></div>}>
            Agents here run headless on Claude, Codex or Gemini. Each has a brief, a budget and a permission level.
          </Empty>
        ) : (
          <div className="agrid">
            {team.map((a) => <AgentCard key={a.name} a={a} projectId={org.projectId} onOpen={() => go("team", a.name)} />)}
          </div>
        )}
        {wsAgents.length > 0 && (
          <section className="card">
            <h3>Workspace agents</h3>
            <p className="muted small">Each workspace has an agent of its own. Talk to it in the workspace chat.</p>
            <div className="list-card">
              {wsAgents.map((a) => (
                <button key={a.name} className="list-row" onClick={() => setPage({ kind: "workspace", id: a.workspaceId! })}>
                  <Avatar name={a.name} provider={a.provider} size={20} live={a.state === "running"} />
                  <span className="list-main"><b>{a.name}</b></span>
                  <span className="muted small">{money(a.spentUsd)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div></div>
      {agent && org.agents.some((a) => a.name === agent) && <AgentDrawer org={org} name={agent} onClose={() => go("team", null)} />}
    </div>
  );
}

function AgentDrawer({ org, name, onClose }: { org: Org; name: string; onClose: () => void }) {
  const open = useStore((s) => s.open);
  const a = org.agents.find((x) => x.name === name)!;
  const [d, setD] = useState<AgentDetail | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const live = org.runs.find((r) => r.agent === name && r.status === "running");
  const version = `${a.runs}:${a.state}:${a.budgetUsd}:${a.level}:${a.provider}:${a.branch}:${a.docket}`;
  useEffect(() => {
    void call("agentDetail", { projectId: org.projectId, name }).then(setD).catch(() => setD(null));
  }, [org.projectId, name, version]);
  const fire = (): void => open({
    kind: "confirm", title: `Fire ${name}?`, danger: true, action: "Fire",
    body: `${name} leaves the team. The ledger keeps every run. ${a.branch ? `The branch ${a.branch} stays until deleted by hand.` : ""}`.trim(),
    run: () => void act(() => call("fireAgent", { projectId: org.projectId, name, reason: null }), `Fired ${name}`).then(onClose),
  });
  return (
    <aside className="drawer" data-testid="agent-drawer">
      <header className="drawer-head">
        <Avatar name={a.name} provider={a.provider} size={36} live={a.state === "running"} />
        <div className="drawer-id">
          <b>{a.name}</b>
          <span className="muted small"><ProviderMark provider={a.provider} size={6} /> {PROVIDER_LABEL[a.provider]} · {modelLabel(a.model)} · {LEVEL_NAME[a.level]}</span>
        </div>
        <Button size="sm" tone="ghost" icon={<X size={14} />} onClick={onClose} aria-label="Close" />
      </header>
      <div className="drawer-actions">
        {!a.workspaceId && <Button size="sm" tone="accent" icon={<Send size={12} />} onClick={() => open({ kind: "delegate", projectId: org.projectId, agent: name })}>Give work</Button>}
        {!a.workspaceId && <Button size="sm" icon={<ListPlus size={12} />} onClick={() => open({ kind: "task", projectId: org.projectId, assignee: name })}>Queue a task</Button>}
        <Menu
          align="right"
          trigger={(_o, t) => <Button size="sm" tone="ghost" icon={<MoreHorizontal size={14} />} onClick={t} aria-label="More" data-testid="agent-more" />}
          items={[
            { label: "Edit", onClick: () => open({ kind: "edit-agent", projectId: org.projectId, name }) },
            ...(!a.branch && !a.workspaceId ? [{ label: "Give a branch of its own", detail: "Later work lands on ceo/" + name, onClick: () => void act(() => call("isolateAgent", { projectId: org.projectId, name }), `${name} now works on a branch`) }] : []),
            { separator: true, label: "" },
            ...(!a.workspaceId ? [{ label: "Fire", danger: true, onClick: fire }] : []),
          ]}
        />
      </div>
      <div className="drawer-body">
        {live && (
          <section className="dsec">
            <h4><Spinner size={10} /> Working on</h4>
            <p className="small">{live.task}</p>
            <div className="dfeed"><RunFeed run={live} /></div>
            <Button size="sm" icon={<Square size={11} />} onClick={() => void call("cancelRun", { projectId: org.projectId, key: live.key })}>Stop</Button>
          </section>
        )}
        <section className="dsec">
          <h4>Role</h4>
          <p className="small pre-wrap">{a.role}</p>
          {a.guardrails.length > 0 && <><h4>Guardrails</h4><ul className="small dlist">{a.guardrails.map((g) => <li key={g}>{g}</li>)}</ul></>}
          {a.collaboration && <><h4>Works with others</h4><p className="small">{a.collaboration}</p></>}
        </section>
        <section className="dsec">
          <h4>Budget</h4>
          <div className="acard-budget"><span className="meter meter-wide"><span style={{ width: `${a.budgetUsd > 0 ? Math.min(100, (a.spentUsd / a.budgetUsd) * 100) : 0}%` }} /></span>{money(a.spentUsd)} {a.budgetUsd > 0 ? `of ${money(a.budgetUsd)}` : "spent, no cap"}</div>
        </section>
        {a.branch && d && (
          <section className="dsec">
            <h4><GitBranch size={12} /> {a.branch}</h4>
            {d.unmerged.length === 0 ? <p className="muted small">Nothing new to merge.</p> : (
              <>
                <ul className="small dlist mono">{d.unmerged.slice(0, 6).map((c) => <li key={c}>{c}</li>)}</ul>
                {!a.workspaceId && (
                  <Button size="sm" icon={<GitMerge size={12} />} disabled={a.state === "running"} data-testid="agent-merge" onClick={() => open({
                    kind: "confirm", title: `Merge ${a.branch}?`, action: "Merge",
                    body: `${d.unmerged.length} commit${d.unmerged.length === 1 ? "" : "s"} land on the branch checked out in the main folder. A conflict undoes the merge.`,
                    run: () => void act(() => call("mergeAgent", { projectId: org.projectId, name })).then((r) => r && useStore.getState().toast(r.message, r.ok ? "ok" : "error")),
                  })}>Merge into the checkout</Button>
                )}
              </>
            )}
          </section>
        )}
        <section className="dsec">
          <h4>Runs</h4>
          {!d ? <Spinner size={12} /> : d.runs.length === 0 ? <p className="muted small">No runs yet.</p> : d.runs.map((r) => (
            <div key={r.id} className="drun">
              <button className="drun-head" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                <ChevronRight size={11} className={openRun === r.id ? "rot90" : ""} />
                <span className={r.ok === false ? "del" : r.ok ? "ok" : "muted"}>{r.ok === false ? <X size={11} /> : <Check size={11} />}</span>
                <span className="drun-task" title={r.task}>{r.task}</span>
                <span className="muted small">{money(r.costUsd)}{r.estimate ? " est." : ""}</span>
                <span className="muted small">{ago(r.ts)}</span>
              </button>
              {openRun === r.id && (
                <div className="drun-body">
                  <div className="result-meta"><span><ProviderMark provider={r.provider} size={6} /> {modelLabel(r.model)}</span><span>{duration(r.durationMs)}</span>{r.denials > 0 && <span className="warn">{r.denials} blocked</span>}</div>
                  {r.output ? <Markdown text={r.output} /> : <p className="muted small">No output was kept.</p>}
                </div>
              )}
            </div>
          ))}
        </section>
        {d && d.docket.length > 0 && (
          <section className="dsec">
            <h4>Docket</h4>
            {d.docket.map((it) => <div key={it.id} className="small dock-mini"><span className="badge">{it.kind}</span> {it.title}</div>)}
          </section>
        )}
        {d && (
          <section className="dsec">
            <button className="drun-head" onClick={() => setShowPrompt(!showPrompt)}><ChevronRight size={11} className={showPrompt ? "rot90" : ""} /> <h4>The prompt it runs under</h4></button>
            {showPrompt && <pre className="log prompt">{d.prompt}</pre>}
          </section>
        )}
      </div>
    </aside>
  );
}

// -- tasks ------------------------------------------------------------------

const COLUMNS: Array<{ id: string; title: string; states: TaskState[] }> = [
  { id: "queued", title: "Queued", states: ["queued", "blocked"] },
  { id: "running", title: "Running", states: ["running", "verifying"] },
  { id: "done", title: "Done", states: ["done"] },
  { id: "failed", title: "Failed or stopped", states: ["failed", "cancelled"] },
];

function TaskCard({ t, org }: { t: Task; org: Org }) {
  const agent = org.agents.find((a) => a.name === t.assignee);
  const pid = org.projectId;
  return (
    <div className={`tcard tcard-${t.priority}`} data-testid={`task-${t.id}`}>
      <div className="tcard-top">
        <TaskBadge status={t.status} />
        {t.priority !== "normal" && <span className={`prio prio-${t.priority}`}>{t.priority}</span>}
        <span className="spacer" />
        {t.costUsd ? <span className="muted small">{money(t.costUsd)}</span> : null}
      </div>
      <p className="tcard-title">{t.title}</p>
      {t.checks.length > 0 && <div className="chips chips-wrap">{t.checks.map((c) => <span key={c} className="chip"><BadgeCheck size={10} /><span className="chip-text">{c}</span></span>)}</div>}
      {t.attempts.length > 0 && (
        <div className="attempts">
          {t.attempts.map((a) => (
            <span key={a.id} className={`attempt ${a.promoted ? "attempt-won" : ""} ${a.pass === false ? "attempt-fail" : a.pass ? "attempt-pass" : ""}`} title={`${a.arm} · ${a.outcome ?? "running"} · ${money(a.costUsd)}`}>
              {a.pass === null ? <Spinner size={9} /> : a.pass ? <Check size={10} /> : <X size={10} />}{a.arm}
            </span>
          ))}
        </div>
      )}
      {t.blockedReason && <p className="small warn">{t.blockedReason}</p>}
      {t.note && t.status !== "done" && <p className="small muted clip2" title={t.note}>{t.note}</p>}
      <div className="tcard-foot">
        {agent ? <><Avatar name={agent.name} provider={agent.provider} size={18} live={agent.state === "running"} /><span className="small">{agent.name}</span></> : <span className="muted small">Unassigned</span>}
        {t.requestedBy && t.requestedBy !== "you" && <span className="muted small">from {t.requestedBy}</span>}
        <span className="spacer" />
        {t.status === "queued" && t.assignee && <Button size="sm" tone="ghost" icon={<Play size={11} />} onClick={() => void act(() => call("runTask", { projectId: pid, id: t.id }))} aria-label="Run now" data-testid={`run-${t.id}`} />}
        {(t.status === "running" || t.status === "verifying" || t.status === "queued" || t.status === "blocked") && <Button size="sm" tone="ghost" icon={<X size={12} />} onClick={() => void act(() => call("cancelTask", { projectId: pid, id: t.id }))} aria-label="Cancel" />}
        {(t.status === "failed" || t.status === "cancelled" || t.status === "done") && <Button size="sm" tone="ghost" icon={<RotateCcw size={11} />} onClick={() => void act(() => call("requeueTask", { projectId: pid, id: t.id }))} aria-label="Run again" />}
        {(t.status === "queued" || t.status === "blocked") && (
          <Menu align="right" trigger={(_o, tg) => <Button size="sm" tone="ghost" icon={<MoreHorizontal size={13} />} onClick={tg} aria-label="Assign" />}
            items={org.agents.filter((a) => !a.chief && !a.workspaceId).map((a) => ({ label: `Give to ${a.name}`, checked: a.name === t.assignee, onClick: () => void act(() => call("editTask", { projectId: pid, id: t.id, assignee: a.name })) }))} />
        )}
      </div>
    </div>
  );
}

function TasksTab({ org }: { org: Org; go: (t: OrgTab, agent?: string | null) => void }) {
  const open = useStore((s) => s.open);
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === org.projectId));
  const auto = !!project?.config.autoDispatch;
  return (
    <div className="page"><div className="page-inner page-wide">
      <div className="toolbar">
        <Button tone="accent" icon={<Plus size={13} />} onClick={() => open({ kind: "task", projectId: org.projectId })}>New task</Button>
        <Button icon={<Play size={12} />} onClick={() => void act(() => call("dispatch", { projectId: org.projectId })).then((r) => r && useStore.getState().toast(r.started ? `${r.started} started` : "Nobody idle has queued work", r.started ? "ok" : "info"))} data-testid="dispatch">Start idle agents</Button>
        <span className="spacer" />
        <label className="inline-toggle">
          <span>Auto-dispatch</span>
          <button role="switch" aria-checked={auto} className={`switch ${auto ? "on" : ""}`} data-testid="auto-dispatch" onClick={() => void act(() => call("saveProjectConfig", { projectId: org.projectId, config: { autoDispatch: !auto } }))}><span /></button>
        </label>
      </div>
      {auto && <p className="muted small">An idle agent starts its next queued task on its own. High priority goes first.</p>}
      {org.tasks.length === 0 ? (
        <Empty icon={<ListTodo size={20} />} title="The queue is empty" action={<Button tone="accent" icon={<Plus size={13} />} onClick={() => open({ kind: "task", projectId: org.projectId })}>New task</Button>}>
          A task can carry checks. The task is done only when an attempt passes them.
        </Empty>
      ) : (
        <div className="board">
          {COLUMNS.map((c) => {
            const list = org.tasks.filter((t) => c.states.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
            return (
              <section key={c.id} className="column">
                <h3>{c.title} <em>{list.length}</em></h3>
                {list.map((t) => <TaskCard key={t.id} t={t} org={org} />)}
              </section>
            );
          })}
        </div>
      )}
    </div></div>
  );
}

// -- live -------------------------------------------------------------------

function RunCard({ run, org, expanded, onToggle }: { run: OrgRun; org: Org; expanded: boolean; onToggle: () => void }) {
  const a = org.agents.find((x) => x.name === run.agent);
  const ref = useRef<HTMLDivElement>(null);
  const size = run.lines.length + (run.lines.at(-1)?.text.length ?? 0);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [size, expanded]);
  return (
    <div className={`rcard ${run.status === "running" ? "rcard-live" : ""}`} data-testid={`run-${run.agent}`}>
      <button className="rcard-head" onClick={onToggle}>
        <Avatar name={run.agent} provider={run.provider ?? a?.provider ?? "claude"} size={24} live={run.status === "running"} />
        <span className="rcard-id">
          <b>{run.agent}</b>
          <span className="muted small clip" title={run.task}>{run.via === "chief" && run.taskId ? "From the chief · " : run.via === "broadcast" ? "Broadcast · " : ""}{run.task}</span>
        </span>
        {run.arm && <span className="chip"><span className="chip-text">{run.arm}</span></span>}
        <RunStatus run={run} />
        {run.status !== "running" && <span className="muted small">{money(run.costUsd)}{run.estimate ? " est." : ""}</span>}
      </button>
      {expanded && (
        <>
          <div className="rcard-feed" ref={ref}><RunFeed run={run} /></div>
          <div className="rcard-foot">
            {run.provider && <span className="muted small"><ProviderMark provider={run.provider} size={6} /> {modelLabel(run.model ?? "")}</span>}
            {run.denials.length > 0 && <span className="warn small"><ShieldAlert size={11} /> {run.denials.length} blocked</span>}
            {run.error && run.status !== "running" && <span className="del small clip" title={run.error}>{run.error}</span>}
            <span className="spacer" />
            {run.status === "running"
              ? <Button size="sm" icon={<Square size={11} />} onClick={() => void call("cancelRun", { projectId: org.projectId, key: run.key })} data-testid="stop-run">Stop</Button>
              : <Button size="sm" tone="ghost" onClick={() => void call("dismissRun", { projectId: org.projectId, key: run.key })}>Dismiss</Button>}
          </div>
        </>
      )}
    </div>
  );
}

function NotesFeed({ org }: { org: Org }) {
  const [to, setTo] = useState("*");
  const [text, setText] = useState("");
  const team = org.agents.filter((a) => !a.workspaceId);
  const post = async (): Promise<void> => {
    if (text.trim().length < 2) return;
    const r = await act(async () => { await call("postNote", { projectId: org.projectId, to, text: text.trim() }); return true; });
    if (r) setText("");
  };
  return (
    <aside className="rail">
      <section className="rail-card">
        <h3>Notes between agents</h3>
        <div className="note-post">
          <Select<string> value={to} label={to === "*" ? "Everyone" : to} options={[{ value: "*", label: "Everyone" }, ...team.map((a) => ({ value: a.name, label: a.name, icon: <ProviderMark provider={a.provider} /> }))]} onChange={setTo} />
          <input className="input" value={text} placeholder="A note the team reads on the next run" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void post()} data-testid="note-input" />
        </div>
        {org.notes.length === 0 && <p className="muted small">Notes, questions and handoffs from the team appear here.</p>}
        {org.notes.slice(0, 40).map((n) => (
          <div key={n.seq} className="tnote">
            <div className="tnote-head"><b>{n.from}</b><ChevronRight size={10} className="muted" /><span>{n.to === "*" ? "everyone" : n.to}</span>{n.ask && <span className="badge">Question</span>}<span className="spacer" /><span className="muted small">{ago(n.ts)}</span></div>
            <p className="small">{n.text}</p>
          </div>
        ))}
      </section>
    </aside>
  );
}

function LiveTab({ org }: { org: Org }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const runs = [...org.runs].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
  const running = runs.filter((r) => r.status === "running").length;
  return (
    <div className="split">
      <div className="page"><div className="page-inner">
        <div className="stats">
          <Stat label="Working now" value={running} detail={running ? "Output streams below" : "Nothing running"} />
          <Stat label="Spent today" value={money(org.spentTodayUsd)} detail="Every agent, from the ledger" />
          <Stat label="Waiting for a decision" value={org.approvals.length} detail={org.approvals.length ? "See Approvals" : "Nothing waiting"} />
        </div>
        {runs.length === 0 ? <Empty icon={<Radio size={20} />} title="Nothing has run yet">Work given to an agent streams here while it runs.</Empty> : runs.map((r) => (
          <RunCard key={r.key} run={r} org={org} expanded={open[r.key] ?? r.status === "running"} onToggle={() => setOpen({ ...open, [r.key]: !(open[r.key] ?? r.status === "running") })} />
        ))}
      </div></div>
      <NotesFeed org={org} />
    </div>
  );
}

// -- map --------------------------------------------------------------------

function MapTab({ org, go }: { org: Org; go: (t: OrgTab, agent?: string | null) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const agents = org.agents.filter((a) => !a.chief);
  const chief = org.agents.find((a) => a.chief) ?? null;
  const W = 820;
  const H = 560;
  const cx = W / 2;
  const cy = H / 2;
  const maxSpend = Math.max(0.01, ...agents.map((a) => a.spentUsd));
  const pos = new Map<string, { x: number; y: number }>();
  if (chief) pos.set(chief.name, { x: cx, y: cy });
  const rings = agents.length > 10 ? 2 : 1;
  agents.forEach((a, i) => {
    const ring = rings === 2 && i % 2 ? 1 : 0;
    const n = rings === 2 ? Math.ceil(agents.length / 2) : agents.length;
    const k = rings === 2 ? Math.floor(i / 2) : i;
    const r = ring ? 235 : 165;
    const t = (k / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2 + (ring ? Math.PI / Math.max(n, 1) : 0);
    pos.set(a.name, { x: cx + Math.cos(t) * r * 1.25, y: cy + Math.sin(t) * r * 0.86 });
  });
  const links = new Map<string, number>();
  for (const n of org.notes) {
    const targets = n.to === "*" ? agents.map((a) => a.name).filter((x) => x !== n.from) : [n.to];
    for (const to of targets) if (pos.has(n.from) && pos.has(to)) links.set(`${n.from}>${to}`, (links.get(`${n.from}>${to}`) ?? 0) + 1);
  }
  if (chief) for (const t of org.tasks) if (t.requestedBy === chief.name && t.assignee && pos.has(t.assignee)) links.set(`${chief.name}>${t.assignee}`, (links.get(`${chief.name}>${t.assignee}`) ?? 0) + 1);
  const focus = hover ? org.agents.find((a) => a.name === hover) : null;
  if (!agents.length && !chief) return <Empty icon={<Orbit size={20} />} title="The map is empty">Hire agents to see the team take shape. Each note between agents draws a line.</Empty>;
  return (
    <div className="map-wrap">
      <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Team map">
        <defs>
          <radialGradient id="map-glow"><stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></radialGradient>
        </defs>
        <ellipse cx={cx} cy={cy} rx={206} ry={142} className="map-orbit" />
        {rings === 2 && <ellipse cx={cx} cy={cy} rx={294} ry={202} className="map-orbit" />}
        {[...links].map(([k, n]) => {
          const [from, to] = k.split(">") as [string, string];
          const a = pos.get(from)!;
          const b = pos.get(to)!;
          const mx = (a.x + b.x) / 2 + (cy - (a.y + b.y) / 2) * 0.18;
          const my = (a.y + b.y) / 2 + ((a.x + b.x) / 2 - cx) * 0.18;
          const on = hover && (from === hover || to === hover);
          return <path key={k} d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`} className={`map-link ${on ? "map-link-on" : ""}`} strokeWidth={Math.min(1 + n * 0.6, 4)} />;
        })}
        {chief && (
          <g className="map-node" transform={`translate(${cx},${cy})`} onMouseEnter={() => setHover(chief.name)} onMouseLeave={() => setHover(null)} onClick={() => go("chief")}>
            <circle r={70} fill="url(#map-glow)" />
            <circle r={26} className={`map-star map-${chief.provider} ${chief.state === "running" || org.chief?.replying ? "map-pulse" : ""}`} />
            <text y={4} className="map-initials">{chief.name.slice(0, 2).toUpperCase()}</text>
            <text y={44} className="map-label">{chief.name}</text>
          </g>
        )}
        {agents.map((a) => {
          const p = pos.get(a.name)!;
          const r = 13 + Math.sqrt(a.spentUsd / maxSpend) * 9;
          return (
            <g key={a.name} className="map-node" transform={`translate(${p.x},${p.y})`} onMouseEnter={() => setHover(a.name)} onMouseLeave={() => setHover(null)} onClick={() => (a.workspaceId ? useStore.getState().setPage({ kind: "workspace", id: a.workspaceId }) : go("team", a.name))} data-testid={`map-${a.name}`}>
              {a.state === "running" && <circle r={r + 9} className={`map-halo map-${a.provider}`} />}
              <circle r={r} className={`map-star map-${a.provider} ${a.workspaceId ? "map-ws" : ""}`} />
              <text y={4} className="map-initials">{a.name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase()}</text>
              <text y={r + 15} className="map-label">{a.name}</text>
            </g>
          );
        })}
      </svg>
      <div className="map-legend">
        {(["claude", "codex", "gemini"] as Provider[]).map((p) => <span key={p}><ProviderMark provider={p} /> {PROVIDER_LABEL[p]}</span>)}
        <span className="muted">Size is spend. Lines are notes and work given out.</span>
      </div>
      {focus && (
        <div className="map-card">
          <b>{focus.name}</b>
          <span className="muted small">{focus.chief ? "Chief of staff" : focus.workspaceId ? "Workspace agent" : LEVEL_NAME[focus.level]} · {money(focus.spentUsd)}</span>
          <span className="small">{focus.state === "running" ? focus.doing : focus.role.slice(0, 120)}</span>
        </div>
      )}
    </div>
  );
}

// -- approvals --------------------------------------------------------------

function ApprovalCard({ a, org }: { a: Approval; org: Org }) {
  const [busy, setBusy] = useState(false);
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true);
    const r = await act(() => call("decide", { projectId: org.projectId, id: a.id, approve }));
    setBusy(false);
    if (r) useStore.getState().toast(r.message, r.ok ? "ok" : "error");
  };
  return (
    <div className="card approval" data-testid={`approval-${a.id}`}>
      <div className="approval-top">
        <span className={`level level-${a.action === "merge" ? "execute" : "autonomous"}`}>{a.action}</span>
        {a.pass !== null && <span className={a.pass ? "ok small" : "del small"}>{a.pass ? <><ShieldCheck size={12} /> Checks passed</> : <><ShieldAlert size={12} /> Checks failed</>}</span>}
        <span className="spacer" />
        <span className="muted small">{a.agent} · {ago(a.ts)}</span>
      </div>
      <p>{a.summary}</p>
      {a.branch && <span className="chip"><GitBranch size={10} /><span className="chip-text">{a.branch}</span></span>}
      {a.evidence.length > 0 && <ul className="evidence">{a.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <div className="approval-actions">
        <Button tone="accent" icon={<Check size={13} />} disabled={busy} onClick={() => void decide(true)} data-testid="approve">{a.action === "merge" ? "Approve and merge" : "Approve"}</Button>
        <Button tone="ghost" disabled={busy} onClick={() => void decide(false)} data-testid="deny">Deny</Button>
      </div>
    </div>
  );
}

function ApprovalsTab({ org }: { org: Org }) {
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === org.projectId));
  return (
    <div className="page"><div className="page-inner">
      <div className="card toggle-card">
        <div className="toggle-row">
          <div>
            <div>Merge on its own when the evidence is clear</div>
            <small className="muted">A deterministic check passed and every judge agreed. Anything else still asks here. Outward actions such as a push always ask.</small>
          </div>
          <button role="switch" aria-checked={org.autoMerge} aria-label="Auto-merge" className={`switch ${org.autoMerge ? "on" : ""}`} onClick={() => void act(() => call("setAutoMerge", { projectId: org.projectId, on: !org.autoMerge }))}><span /></button>
        </div>
      </div>
      {org.approvals.length === 0 ? (
        <Empty icon={<Inbox size={20} />} title="Nothing waiting">A task that passes its checks asks here before the work merges into {project?.name ?? "the project"}.</Empty>
      ) : (
        <>
          <p className="muted small">Approving a merge lands it on the branch checked out in {project?.path}. The checkout must be clean.</p>
          {org.approvals.map((a) => <ApprovalCard key={a.id} a={a} org={org} />)}
        </>
      )}
    </div></div>
  );
}

// -- docket -----------------------------------------------------------------

function DocketTab({ org }: { org: Org }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const team = org.agents.filter((a) => !a.chief);
  const add = async (): Promise<void> => {
    if (!input.trim() || busy) return;
    setBusy(true);
    const r = await act(() => call("addDocket", { projectId: org.projectId, input: input.trim(), agents: [] }), "Added to the docket");
    setBusy(false);
    if (r) setInput("");
  };
  const groups = [...new Set(org.docket.map((d) => d.group))];
  return (
    <div className="page"><div className="page-inner">
      <div className="docket-add">
        <FileText size={14} className="muted" />
        <input className="input" value={input} disabled={busy} placeholder="A file, a folder, #42, a PR URL, hf:org/model, a web page, skill:name or a plain note" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} data-testid="docket-input" />
        <Button tone="accent" disabled={!input.trim() || busy} onClick={() => void add()}>{busy ? <Spinner size={11} /> : "Add"}</Button>
      </div>
      <p className="muted small">Each item reaches only the agents it is given to. Larger items cost more on every run.</p>
      {org.docket.length === 0 ? <Empty icon={<BookOpen size={20} />} title="The docket is empty">Give agents the files, issues, papers and notes the work depends on.</Empty> : groups.map((g) => (
        <section key={g} className="card">
          <h3>{g}</h3>
          {org.docket.filter((d) => d.group === g).map((d) => <DocketRow key={d.id} d={d} org={org} team={team} />)}
        </section>
      ))}
    </div></div>
  );
}

function DocketRow({ d, org, team }: { d: DocketItem; org: Org; team: Agent[] }) {
  return (
    <div className="dock" data-testid={`docket-${d.id}`}>
      <span className="badge">{d.kind}</span>
      <span className="dock-main"><b>{d.title}</b><small className="muted">{d.source} · {d.tokens}</small></span>
      <div className="chips chips-wrap dock-agents">
        {team.map((a) => {
          const on = d.agents.includes(a.name);
          return <button key={a.name} className={`chip chip-btn ${on ? "chip-on" : ""}`} title={on ? `Take from ${a.name}` : `Give to ${a.name}`} onClick={() => void act(() => call("shareDocket", { projectId: org.projectId, id: d.id, agent: a.name, give: !on }))}><ProviderMark provider={a.provider} size={6} />{a.name}</button>;
        })}
      </div>
      <Button size="sm" tone="ghost" icon={<RefreshCw size={12} />} onClick={() => void act(() => call("refreshDocket", { projectId: org.projectId, id: d.id }), "Refreshed")} aria-label="Refresh" />
      <Button size="sm" tone="ghost" icon={<Trash2 size={12} />} onClick={() => void act(() => call("removeDocket", { projectId: org.projectId, id: d.id }))} aria-label="Remove" />
    </div>
  );
}

// -- mission ----------------------------------------------------------------

function MissionTab({ org }: { org: Org }) {
  const m = org.mission;
  const [objective, setObjective] = useState(m?.objective ?? "");
  const [criteria, setCriteria] = useState((m?.criteria ?? []).join("\n"));
  const [guardrails, setGuardrails] = useState((m?.guardrails ?? []).join("\n"));
  const [checks, setChecks] = useState((m?.checks ?? []).map((c) => c.spec).join("\n"));
  const [checking, setChecking] = useState(false);
  const split = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const save = (): void => void act(() => call("setMission", { projectId: org.projectId, objective, criteria: split(criteria), guardrails: split(guardrails), checks: split(checks) }), "Mission saved");
  return (
    <div className="page"><div className="page-inner page-narrow">
      <p className="muted">Every agent reads the mission at the start of every run. A vague mission gives vague work across the whole team.</p>
      <Field label="Objective"><textarea className="input" rows={3} value={objective} data-testid="mission-objective" placeholder="Ship a stable 2.0 of the retry library with full test coverage." onChange={(e) => setObjective(e.target.value)} /></Field>
      <div className="form-row">
        <Field label="Done means" hint="One per line."><textarea className="input" rows={4} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder={"Every public function has a test\nNo open bugs labeled 2.0"} /></Field>
        <Field label="Rules for everyone" hint="One per line. Added to every agent's guardrails."><textarea className="input" rows={4} value={guardrails} onChange={(e) => setGuardrails(e.target.value)} placeholder={"Never push to main\nNever add a dependency without a note"} /></Field>
      </div>
      <Field label="Checks" hint="One per line. The mission is met when every check passes."><textarea className="input code-input" rows={3} value={checks} onChange={(e) => setChecks(e.target.value)} placeholder="npm test" /></Field>
      <div className="toolbar">
        <Button tone="accent" disabled={objective.trim().length < 10} onClick={save} data-testid="mission-save">Save mission</Button>
        {m && m.checks.length > 0 && <Button icon={checking ? <Spinner size={11} /> : <ShieldCheck size={13} />} disabled={checking} onClick={() => { setChecking(true); void act(() => call("checkMission", { projectId: org.projectId })).finally(() => setChecking(false)); }}>Run the checks</Button>}
        {m && <span className="muted small">Saved {ago(m.setAt)} ago</span>}
      </div>
      {m && m.checks.length > 0 && (
        <section className="card">
          <h3>Checks</h3>
          {m.checks.map((c) => (
            <div key={c.spec} className="check-line">
              {c.state === "pass" ? <Check size={13} className="ok" /> : c.state === "fail" || c.state === "error" ? <X size={13} className="del" /> : <span className="dot" />}
              <code>{c.spec}</code>
              <span className="spacer" />
              <span className="muted small">{c.at ? ago(c.at) : "Not run yet"}</span>
            </div>
          ))}
        </section>
      )}
    </div></div>
  );
}

// -- integrations -----------------------------------------------------------

function IntegrationsTab({ org }: { org: Org }) {
  const [x, setX] = useState<Integrations | null>(null);
  const [ledger, setLedger] = useState(org.ledger);
  useEffect(() => {
    void call("integrations", { projectId: org.projectId }).then(setX).catch(() => setX(null));
  }, [org.projectId]);
  const row = (icon: ReactNode, title: string, ready: boolean, detail: string): ReactNode => (
    <div className="integ">
      <span className="integ-icon">{icon}</span>
      <span className="list-main"><b>{title}</b><small className="muted">{detail}</small></span>
      <span className={ready ? "ok small" : "muted small"}>{ready ? "Ready" : "Not set up"}</span>
    </div>
  );
  return (
    <div className="page"><div className="page-inner page-narrow">
      <section className="card">
        <h3>Record</h3>
        <div className="integ">
          <span className="integ-icon">{ledger.ok ? <ShieldCheck size={15} className="ok" /> : <ShieldAlert size={15} className="del" />}</span>
          <span className="list-main"><b>{ledger.ok ? "The ledger is intact" : "The ledger was altered"}</b><small className="muted">{ledger.detail}</small></span>
          <Button size="sm" onClick={() => void act(() => call("verifyLedger", { projectId: org.projectId })).then((r) => r && setLedger(r))}>Verify</Button>
        </div>
      </section>
      {!x ? <div className="center"><Spinner size={16} /></div> : (
        <>
          <section className="card">
            <h3>Sources</h3>
            {row(<Github size={15} />, "GitHub", x.github.ready, x.github.detail)}
            {row(<Bot size={15} />, "Hugging Face", x.huggingface.ready, x.huggingface.detail)}
          </section>
          <section className="card">
            <h3>Sandboxes</h3>
            <p className="muted small">A task can run in a container or on a remote host instead of this machine.</p>
            {x.sandboxes.map((s) => row(<Box size={15} />, s.kind === "docker" ? "Docker" : "SSH host", s.ready, s.detail))}
          </section>
          <section className="card">
            <h3>Skills</h3>
            {x.skills.length === 0 ? <p className="muted small">No skills found in Reflex, Claude Code, Codex or this repository.</p> : x.skills.slice(0, 30).map((s) => (
              <div key={`${s.source}:${s.name}`} className="integ">
                <span className="badge">{s.source}</span>
                <span className="list-main"><b>{s.name}</b><small className="muted">{s.description}</small></span>
                <Button size="sm" tone="ghost" onClick={() => void act(() => call("addDocket", { projectId: org.projectId, input: `skill:${s.name}`, agents: [] }), "Added to the docket")}>Add to docket</Button>
              </div>
            ))}
          </section>
        </>
      )}
    </div></div>
  );
}
