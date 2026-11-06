import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, BarChart3, Building2, CircleDollarSign, Crown, Inbox, ListPlus, Radio, UserPlus, Users, Flag, GitBranch, GitPullRequest, History, KeyRound, Layers, Plus, Settings as SettingsIcon, Sparkles, Terminal as TerminalIcon, Trophy, Check, CircleAlert, RefreshCw,
} from "lucide-react";

import type { ListItem, Mode, PlanDraft, PlannedTask, Provider, Readiness } from "../../shared/api";
import { call, desktop } from "../api";
import { mod, modelLabel, money, PROVIDER_LABEL, SHIFT } from "../format";
import { act, useStore } from "../store";
import { TerminalView } from "./Inspector";
import { addProjectFlow } from "./Sidebar";
import { BroadcastDialog, CompanyDialog, DelegateDialog, EditAgentDialog, HireDialog, SuggestDialog, TaskDialog } from "./OrgDialogs";
import { Button, Dialog, Empty, Field, Kbd, ProviderMark, Select, Spinner } from "./ui";

function useProject(initial?: string): [string, (v: string) => void] {
  const projects = useStore((s) => s.snapshot.projects);
  const page = useStore((s) => s.page);
  const workspaces = useStore((s) => s.snapshot.workspaces);
  const current = page.kind === "workspace" ? workspaces.find((w) => w.id === page.id)?.projectId : undefined;
  const [id, setId] = useState(initial ?? current ?? projects[0]?.id ?? "");
  return [id, setId];
}

function ProjectSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const projects = useStore((s) => s.snapshot.projects);
  return (
    <Select<string>
      value={value}
      options={projects.map((p) => ({ value: p.id, label: p.name, detail: p.path }))}
      onChange={onChange}
    />
  );
}

export function defaultModel(readiness: Readiness[], provider: Provider): string {
  const pref = useStore.getState().settings?.defaultModels[provider];
  return pref ?? readiness.find((r) => r.provider === provider)?.defaultModel ?? "";
}

export function firstReady(readiness: Readiness[], preferred?: Provider): Provider {
  if (preferred && readiness.find((r) => r.provider === preferred)?.ready) return preferred;
  return readiness.find((r) => r.ready)?.provider ?? preferred ?? "claude";
}

export function ProviderSelect({ value, onChange }: { value: Provider; onChange: (p: Provider) => void }) {
  const readiness = useStore((s) => s.readiness);
  return (
    <Select<Provider>
      value={value}
      options={(["claude", "codex", "gemini"] as Provider[]).map((p) => {
        const r = readiness.find((x) => x.provider === p);
        return { value: p, label: PROVIDER_LABEL[p], icon: <ProviderMark provider={p} />, disabled: !r?.ready, detail: r?.ready ? (r.metered ? "Metered API key" : r.account) : "Not signed in" };
      })}
      onChange={onChange}
    />
  );
}

function NewWorkspaceDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const readiness = useStore((s) => s.readiness);
  const settings = useStore((s) => s.settings);
  const projects = useStore((s) => s.snapshot.projects);
  const setPage = useStore((s) => s.setPage);
  const [pid, setPid] = useProject(projectId);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState<Provider>(firstReady(readiness, settings?.defaultProvider));
  const [model, setModel] = useState(defaultModel(readiness, firstReady(readiness, settings?.defaultProvider)));
  const [mode, setMode] = useState<Mode>("build");
  const [source, setSource] = useState<"base" | "branch" | "pr" | "issue">("base");
  const [list, setList] = useState<ListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const project = projects.find((p) => p.id === pid);

  useEffect(() => {
    setList(null);
    setChosen("");
    setListError(null);
    if (source === "base" || !pid) return;
    const method = source === "branch" ? "branches" : source === "pr" ? "pullRequests" : "issues";
    void call(method, { projectId: pid }).then(setList).catch((e: Error) => {
      setList([]);
      setListError(e.message);
    });
  }, [source, pid]);

  const submit = async (): Promise<void> => {
    if (!project || busy) return;
    if (source !== "base" && !chosen) return;
    setBusy(true);
    const firstLine = prompt.trim().split("\n")[0]?.slice(0, 60) ?? "";
    const item = list?.find((l) => l.value === chosen);
    const w = await act(() => call("createWorkspace", {
      projectId: pid,
      title: title.trim() || firstLine || item?.title.replace(/^#\d+\s/, "") || "",
      start: source === "base" ? { kind: "base" } : source === "branch" ? { kind: "branch", ref: chosen } : source === "pr" ? { kind: "pr", number: Number(chosen) } : { kind: "issue", number: Number(chosen) },
      prompt: prompt.trim() || undefined,
      provider, model, mode,
    }));
    setBusy(false);
    if (w) {
      setPage({ kind: "workspace", id: w.id });
      onClose();
    }
  };

  if (project && !project.hasCommits) {
    return (
      <Dialog title="This project has no commits" onClose={onClose} footer={<Button tone="accent" onClick={() => void act(() => call("createFirstCommit", { projectId: pid }), "Repository ready")}>{project.isGit ? "Create a first commit" : "Initialize git"}</Button>}>
        <p className="muted">A workspace is a branch and a worktree. Git needs one commit to branch from. An empty first commit changes no files.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New workspace"
      subtitle="A new branch and working copy. Nothing touches the main checkout."
      onClose={onClose}
      width={620}
      testId="new-workspace-dialog"
      footer={
        <>
          <span className="foot-left"><Kbd>{mod("↵")}</Kbd> create</span>
          <Button tone="ghost" onClick={onClose}>Cancel</Button>
          <Button tone="accent" disabled={busy || !project || (source !== "base" && !chosen)} onClick={() => void submit()} data-testid="create-workspace">{prompt.trim() ? "Create and start" : "Create"}</Button>
        </>
      }
    >
      <textarea
        className="big-input"
        autoFocus
        rows={4}
        value={prompt}
        data-testid="new-prompt"
        placeholder="What should the agent do? Leave empty to start with a blank workspace."
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }}
      />
      <div className="form-row">
        <Field label="Project"><ProjectSelect value={pid} onChange={setPid} /></Field>
        <Field label="Agent">
          <ProviderSelect value={provider} onChange={(p) => { setProvider(p); setModel(defaultModel(readiness, p)); }} />
        </Field>
        <Field label="Model">
          <Select<string> value={model} label={modelLabel(model)} options={(readiness.find((r) => r.provider === provider)?.models ?? [model]).map((m) => ({ value: m, label: modelLabel(m) }))} onChange={setModel} />
        </Field>
        <Field label="Mode">
          <div className="segmented">
            <button className={mode === "build" ? "on" : ""} onClick={() => setMode("build")}>Build</button>
            <button className={mode === "plan" ? "on" : ""} onClick={() => setMode("plan")}>Plan</button>
          </div>
        </Field>
      </div>
      <Field label="Start from">
        <div className="segmented segmented-wide">
          <button className={source === "base" ? "on" : ""} onClick={() => setSource("base")}>{project?.baseRef ?? "Base"}</button>
          <button className={source === "branch" ? "on" : ""} onClick={() => setSource("branch")} data-testid="from-branch"><GitBranch size={12} /> Branch</button>
          <button className={source === "pr" ? "on" : ""} onClick={() => setSource("pr")} disabled={!project?.hasRemote}><GitPullRequest size={12} /> Pull request</button>
          <button className={source === "issue" ? "on" : ""} onClick={() => setSource("issue")} disabled={!project?.hasRemote} data-testid="from-issue"><CircleAlert size={12} /> Issue</button>
        </div>
      </Field>
      {source !== "base" && (
        <div className="picker">
          {!list && <div className="center"><Spinner size={14} /></div>}
          {listError && <p className="muted small picker-note">{listError}</p>}
          {list?.length === 0 && !listError && <p className="muted small picker-note">Nothing to pick from.</p>}
          {list?.map((l) => (
            <button key={l.value} className={`picker-row ${chosen === l.value ? "on" : ""}`} onClick={() => setChosen(l.value)}>
              <span>{l.title}</span><small>{l.detail}</small>
            </button>
          ))}
        </div>
      )}
      {source !== "base" && (
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Taken from the selection when empty" /></Field>
      )}
    </Dialog>
  );
}

function RaceDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const readiness = useStore((s) => s.readiness);
  const projects = useStore((s) => s.snapshot.projects);
  const setPage = useStore((s) => s.setPage);
  const [pid, setPid] = useProject(projectId);
  const project = projects.find((p) => p.id === pid);
  const [prompt, setPrompt] = useState("");
  const [check, setCheck] = useState(project?.config.check ?? "");
  const [arms, setArms] = useState<Record<Provider, boolean>>(() => ({ claude: !!readiness.find((r) => r.provider === "claude")?.ready, codex: !!readiness.find((r) => r.provider === "codex")?.ready, gemini: !!readiness.find((r) => r.provider === "gemini")?.ready }));
  const [busy, setBusy] = useState(false);
  useEffect(() => setCheck(project?.config.check ?? ""), [project?.id, project?.config.check]);
  const chosen = (Object.keys(arms) as Provider[]).filter((p) => arms[p]);
  const submit = async (): Promise<void> => {
    setBusy(true);
    const r = await act(() => call("startRace", { projectId: pid, title: "", prompt, check, arms: chosen.map((p) => ({ provider: p, model: defaultModel(readiness, p) })) }));
    setBusy(false);
    if (r) {
      setPage({ kind: "race", id: r.id });
      onClose();
    }
  };
  return (
    <Dialog
      title={<><Flag size={15} className="title-ic" /> Race agents</>}
      subtitle="The same task runs on several agents, each on its own branch. The check decides. Only the winner lands."
      onClose={onClose}
      width={620}
      testId="race-dialog"
      footer={<>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" disabled={busy || !prompt.trim() || chosen.length < 2} onClick={() => void submit()} data-testid="start-race">Start {chosen.length} agents</Button>
      </>}
    >
      <textarea className="big-input" autoFocus rows={4} value={prompt} data-testid="race-prompt" placeholder="Describe the task every agent will attempt." onChange={(e) => setPrompt(e.target.value)} />
      <Field label="Project"><ProjectSelect value={pid} onChange={setPid} /></Field>
      <Field label="Agents">
        <div className="arm-grid">
          {readiness.map((r) => (
            <button key={r.provider} disabled={!r.ready} className={`arm ${arms[r.provider] ? "on" : ""}`} onClick={() => setArms({ ...arms, [r.provider]: !arms[r.provider] })} data-testid={`arm-${r.provider}`}>
              <ProviderMark provider={r.provider} size={9} />
              <span><b>{PROVIDER_LABEL[r.provider]}</b><small>{r.ready ? modelLabel(defaultModel(readiness, r.provider)) : "Not signed in"}</small></span>
              {arms[r.provider] && <Check size={14} />}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Check" hint="Runs in each agent's worktree. Exit 0 passes. The cheapest pass wins. Without a check, the choice is manual.">
        <input className="input mono" value={check} data-testid="race-check" placeholder="npm test" onChange={(e) => setCheck(e.target.value)} />
      </Field>
      <p className="muted small">Each agent draws on the plan it is signed in with. A race uses {chosen.length} times the usage of a single run.</p>
    </Dialog>
  );
}

function PlanDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const readiness = useStore((s) => s.readiness);
  const settings = useStore((s) => s.settings);
  const setPage = useStore((s) => s.setPage);
  const [pid, setPid] = useProject(projectId);
  const [goal, setGoal] = useState("");
  const [provider, setProvider] = useState<Provider>(firstReady(readiness, settings?.defaultProvider));
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<PlannedTask>): void => setDraft((d) => (d ? { ...d, tasks: d.tasks.map((t, n) => (n === i ? { ...t, ...patch } : t)) } : d));
  const generate = async (): Promise<void> => {
    setBusy(true);
    const d = await act(() => call("draftPlan", { projectId: pid, goal, provider }));
    setBusy(false);
    if (d) setDraft(d);
  };
  const launch = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    const models: Partial<Record<Provider, string>> = {};
    for (const r of readiness) models[r.provider] = defaultModel(readiness, r.provider);
    const made = await act(() => call("launchPlan", { projectId: pid, tasks: draft.tasks, model: models }));
    setBusy(false);
    if (made?.[0]) {
      setPage({ kind: "workspace", id: made[0].id });
      onClose();
    }
  };
  const count = draft?.tasks.filter((t) => t.selected).length ?? 0;
  return (
    <Dialog
      title={<><Sparkles size={15} className="title-ic" /> Plan from a goal</>}
      subtitle="A read-only agent reads the repository and proposes separate workspaces. Nothing starts until approved."
      onClose={onClose}
      width={680}
      testId="plan-dialog"
      footer={draft ? <>
        <span className="foot-left muted">Planning cost {money(draft.costUsd)}</span>
        <Button tone="ghost" onClick={() => setDraft(null)}>Back</Button>
        <Button tone="accent" disabled={busy || count === 0} onClick={() => void launch()} data-testid="launch-plan">Start {count} workspace{count === 1 ? "" : "s"}</Button>
      </> : <>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" disabled={busy || !goal.trim()} icon={busy ? <Spinner size={12} /> : <Sparkles size={13} />} onClick={() => void generate()} data-testid="draft-plan">{busy ? "Reading the repository" : "Draft a plan"}</Button>
      </>}
    >
      {!draft ? (
        <>
          <textarea className="big-input" autoFocus rows={4} value={goal} data-testid="plan-goal" placeholder="Add rate limiting to the public API, with tests and docs." onChange={(e) => setGoal(e.target.value)} />
          <div className="form-row">
            <Field label="Project"><ProjectSelect value={pid} onChange={setPid} /></Field>
            <Field label="Planner"><ProviderSelect value={provider} onChange={setProvider} /></Field>
          </div>
        </>
      ) : (
        <>
          {draft.rationale && <p className="plan-why">{draft.rationale}</p>}
          <div className="plan-list">
            {draft.tasks.map((t, i) => (
              <div className={`plan-task ${t.selected ? "" : "plan-off"}`} key={i} data-testid="plan-task">
                <button className="todo-box" aria-label={t.selected ? "Skip this task" : "Include this task"} onClick={() => set(i, { selected: !t.selected })}>{t.selected && <Check size={11} />}</button>
                <div className="plan-body">
                  <input className="plan-title" value={t.title} aria-label="Task title" onChange={(e) => set(i, { title: e.target.value })} />
                  <textarea className="plan-prompt" rows={2} value={t.prompt} aria-label="Task instructions" onChange={(e) => set(i, { prompt: e.target.value })} />
                </div>
                <ProviderSelect value={t.provider} onChange={(p) => set(i, { provider: p })} />
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}

function CreatePrDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call("draftPr", { id }).then((d) => { setTitle(d.title); setBody(d.body); setBase(d.base); }).catch((e: Error) => useStore.getState().toast(e.message, "error"));
  }, [id]);
  return (
    <Dialog
      title="Create pull request"
      subtitle={base && `Pushes this branch and opens a pull request into ${base}.`}
      onClose={onClose}
      width={640}
      testId="pr-dialog"
      footer={<>
        <label className="check-row foot-left"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft</label>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" disabled={busy || !title.trim()} icon={busy ? <Spinner size={12} /> : <GitPullRequest size={13} />} data-testid="submit-pr" onClick={() => void (async () => {
          setBusy(true);
          const pr = await act(() => call("createPr", { id, title, body, draft }));
          setBusy(false);
          if (pr) {
            useStore.getState().toast(`Opened #${pr.number}`, "ok", { label: "View", run: () => void desktop.openExternal(pr.url) });
            onClose();
          }
        })()}>Create pull request</Button>
      </>}
    >
      <Field label="Title"><input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="pr-title" /></Field>
      <Field label="Description"><textarea className="input code-input" rows={12} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    </Dialog>
  );
}

function ProjectDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === projectId));
  const [c, setC] = useState(project?.config);
  // Held as typed. Splitting on every keystroke would swallow the comma before the next name.
  const [copy, setCopy] = useState(project?.config.copy.join(", ") ?? "");
  if (!project || !c) return null;
  const save = (): void => void act(async () => {
    await call("saveProjectConfig", { projectId, config: { ...c, copy: copy.split(",").map((x) => x.trim()).filter(Boolean) } });
    onClose();
  }, "Saved");
  const row = (k: "setup" | "run" | "check" | "archive", label: string, hint: string, ph: string) => (
    <Field label={label} hint={hint}>
      <textarea className="input code-input" rows={2} value={c[k]} placeholder={ph} data-testid={`config-${k}`} onChange={(e) => setC({ ...c, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog
      title={`${project.name} settings`}
      subtitle={project.path}
      onClose={onClose}
      width={640}
      testId="project-dialog"
      footer={<>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" onClick={save} data-testid="save-project">Save</Button>
      </>}
    >
      {row("setup", "Setup script", "Runs once in each new workspace, before the agent.", "npm install")}
      {row("run", "Run script", "The Run button. $CEO_PORT holds a port reserved for the workspace.", "npm run dev -- --port $CEO_PORT")}
      {row("check", "Check", "Says whether the work is right. Race and the Checks tab use this.", "npm test")}
      {row("archive", "Archive script", "Runs before a workspace is archived.", "docker compose down")}
      <div className="form-row">
        <Field label="Base branch" hint="New work branches from here."><input className="input mono" value={c.baseBranch} placeholder={project.baseRef} onChange={(e) => setC({ ...c, baseBranch: e.target.value })} /></Field>
        <Field label="Copy into new workspaces" hint="Files git ignores, comma separated."><input className="input mono" value={copy} onChange={(e) => setCopy(e.target.value)} /></Field>
      </div>
      <Field label="Guidance for every agent" hint="Conventions and limits for this project. Applies to new workspaces.">
        <textarea className="input" rows={4} value={c.instructions} onChange={(e) => setC({ ...c, instructions: e.target.value })} />
      </Field>
    </Dialog>
  );
}

export function ProviderCard({ r, onTerminal }: { r: Readiness; onTerminal: (r: Readiness) => void }) {
  return (
    <div className={`pcard ${r.ready ? "pcard-ready" : ""}`} data-testid={`provider-${r.provider}`}>
      <ProviderMark provider={r.provider} size={10} />
      <div className="pcard-main">
        <div className="pcard-title">{PROVIDER_LABEL[r.provider]} {r.isStub && <span className="badge">test double</span>}</div>
        <div className="pcard-sub">
          {r.ready ? (r.metered ? <span className="warn">Bills a metered API key: {r.account}</span> : r.account) : r.installed ? "Installed. Needs a sign-in." : "Not installed"}
        </div>
      </div>
      {r.ready ? <Check size={15} className="ok" /> : <Button size="sm" icon={<TerminalIcon size={12} />} onClick={() => onTerminal(r)}>{r.installed ? "Sign in" : "Install"}</Button>}
    </div>
  );
}

export function SetupTerminal({ r, onClose }: { r: Readiness; onClose: () => void }) {
  const refresh = useStore((s) => s.refreshReadiness);
  const finish = (): void => {
    void refresh(true);
    void call("terminalClose", { terminalId: `login:${r.provider}` });
    onClose();
  };
  return (
    <Dialog
      title={`Set up ${PROVIDER_LABEL[r.provider]}`}
      subtitle={r.installed ? "The sign-in command is typed and waiting. Press return to run it." : "The install command is typed and waiting. Press return to run it."}
      width={760}
      onClose={finish}
      footer={<Button tone="accent" icon={<RefreshCw size={13} />} onClick={finish}>Done</Button>}
    >
      <div className="setup-term"><TerminalView terminalId={`login:${r.provider}`} initial={r.fixCommand} /></div>
    </Dialog>
  );
}

function SettingsDialog({ tab, onClose }: { tab?: "general" | "providers" | "license"; onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const save = useStore((s) => s.saveSettings);
  const readiness = useStore((s) => s.readiness);
  const refresh = useStore((s) => s.refreshReadiness);
  const [current, setCurrent] = useState(tab ?? "general");
  const [term, setTerm] = useState<Readiness | null>(null);
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<string | null>(null);
  useEffect(() => void desktop.version().then(setVersion), []);
  if (!settings) return null;
  if (term) return <SetupTerminal r={term} onClose={() => setTerm(null)} />;
  return (
    <Dialog title="Settings" onClose={onClose} width={640} testId="settings-dialog">
      <div className="segmented segmented-wide settings-tabs">
        <button className={current === "general" ? "on" : ""} onClick={() => setCurrent("general")}>General</button>
        <button className={current === "providers" ? "on" : ""} onClick={() => setCurrent("providers")} data-testid="settings-providers">Agents</button>
        <button className={current === "license" ? "on" : ""} onClick={() => setCurrent("license")} data-testid="settings-license">License</button>
      </div>
      {current === "general" && (
        <div className="settings">
          <Field label="Appearance">
            <div className="segmented">
              {(["system", "light", "dark"] as const).map((t) => <button key={t} className={settings.theme === t ? "on" : ""} data-testid={`theme-${t}`} onClick={() => void save({ theme: t })}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
            </div>
          </Field>
          <Toggle label="Sound when an agent finishes" value={settings.sound} onChange={(sound) => void save({ sound })} />
          <Toggle label="Desktop notifications" value={settings.notifications} onChange={(notifications) => void save({ notifications })} />
          <Toggle label="Agents in a project can message each other" hint="Agents post notes on a shared board. A workspace reads teammates' notes on its next turn." value={settings.teamNotes} onChange={(teamNotes) => void save({ teamNotes })} />
          <Field label="Budget per new workspace" hint="A hard cap. An agent stops at this figure. Estimated at list price on a plan.">
            <input className="input mono narrow" type="number" min={1} value={settings.defaultBudgetUsd} data-testid="default-budget" onChange={(e) => Number(e.target.value) > 0 && void save({ defaultBudgetUsd: Number(e.target.value) })} />
          </Field>
          <div className="about">
            <span className="muted">CEO {version}</span>
            <Button size="sm" tone="ghost" onClick={() => void desktop.checkForUpdates().then((u) => setUpdate(u.detail))}>Check for updates</Button>
            <Button size="sm" tone="ghost" onClick={() => void desktop.revealLogs()}>Show logs</Button>
            {update && <span className="muted small">{update}</span>}
          </div>
        </div>
      )}
      {current === "providers" && (
        <div className="settings">
          <p className="muted">No API key is needed. CEO runs the CLIs already signed in on this machine and stores no credential.</p>
          {readiness.map((r) => <ProviderCard key={r.provider} r={r} onTerminal={setTerm} />)}
          <Button size="sm" tone="ghost" icon={<RefreshCw size={12} />} onClick={() => void refresh(true)}>Check again</Button>
          <Field label="Default agent">
            <Select<Provider> value={settings.defaultProvider} options={(["claude", "codex", "gemini"] as Provider[]).map((p) => ({ value: p, label: PROVIDER_LABEL[p], icon: <ProviderMark provider={p} /> }))} onChange={(defaultProvider) => void save({ defaultProvider })} />
          </Field>
        </div>
      )}
      {current === "license" && <LicensePanel />}
    </Dialog>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="toggle-row">
      <div><div>{label}</div>{hint && <small className="muted">{hint}</small>}</div>
      <button role="switch" aria-checked={value} aria-label={label} className={`switch ${value ? "on" : ""}`} onClick={() => onChange(!value)}><span /></button>
    </div>
  );
}

const PRO = [
  { icon: <Crown size={14} />, title: "Chief of staff", body: "One conversation hires, briefs and starts a whole team." },
  { icon: <Users size={14} />, title: "Unlimited team", body: "The free plan holds 3 agents per project. Pro adds companies and verified attempts." },
  { icon: <Layers size={14} />, title: "Unlimited workspaces", body: "The free plan holds 3 at a time." },
  { icon: <Flag size={14} />, title: "Race", body: "One task on several agents. A real check picks the winner." },
  { icon: <Sparkles size={14} />, title: "Plan from a goal", body: "One goal becomes reviewed, separate workspaces." },
  { icon: <BarChart3 size={14} />, title: "Insights", body: "Which agent passes which kind of work in this repository." },
  { icon: <CircleDollarSign size={14} />, title: "Ledger export", body: "The tamper-evident record of every run, as a file." },
];

function LicensePanel() {
  const license = useStore((s) => s.license);
  const [key, setKey] = useState("");
  if (!license) return null;
  if (license.plan === "pro") {
    return (
      <div className="settings">
        <div className="plan-box plan-box-pro"><Trophy size={16} /> <div><b>CEO Pro</b><small className="muted"> Licensed to {license.email}{license.expiresAt ? `, until ${new Date(license.expiresAt).toLocaleDateString()}` : ""}</small></div></div>
        <Button size="sm" tone="ghost" onClick={() => void act(() => call("deactivateLicense"), "License removed from this machine")}>Remove from this machine</Button>
      </div>
    );
  }
  return (
    <div className="settings">
      <div className="pro-list">
        {PRO.map((p) => (
          <div className="pro-item" key={p.title}>{p.icon}<div><b>{p.title}</b><small className="muted">{p.body}</small></div></div>
        ))}
      </div>
      <div className="plan-box">
        {license.plan === "trial" ? <span>Every Pro feature is on for {license.trialDaysLeft} more days.</span> : <span>The trial has ended. Workspaces, chat, review and merge stay free.</span>}
        {license.checkoutUrl && <Button tone="accent" size="sm" onClick={() => void desktop.openExternal(license.checkoutUrl)} data-testid="buy">Buy Pro · $20 a month</Button>}
      </div>
      <Field label="License key">
        <div className="key-row">
          <input className="input mono" value={key} placeholder="CEO1..." data-testid="license-key" onChange={(e) => setKey(e.target.value)} />
          <Button tone="accent" icon={<KeyRound size={13} />} disabled={!key.trim()} data-testid="activate" onClick={() => void act(() => call("activateLicense", { key }), "Welcome to CEO Pro")}>Activate</Button>
        </div>
      </Field>
      {license.error && <p className="del small">{license.error}</p>}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["Command palette", mod("K")], ["New workspace", `${mod(SHIFT)}N`], ["Race agents", `${mod(SHIFT)}R`], ["Plan from a goal", `${mod(SHIFT)}G`], ["New chat tab", mod("T")],
    ["Jump to workspace", `${mod("1")} to ${mod("9")}`], ["Review changes", `${mod(SHIFT)}D`], ["Create pull request", `${mod(SHIFT)}P`], ["Terminal", mod("J")], ["Run", mod("R")], ["Stop agent", mod(".")],
    ["Archive workspace", `${mod(SHIFT)}A`], ["Chief of staff", `${mod(SHIFT)}C`], ["Team", `${mod(SHIFT)}M`], ["Hire an agent", `${mod(SHIFT)}H`], ["New task", `${mod(SHIFT)}T`], ["Toggle sidebar", mod("B")], ["Toggle inspector", `${mod("⌥")}B`], ["Add project", mod("O")], ["Settings", mod(",")],
  ];
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={520}>
      <div className="shortcuts">
        {rows.map(([l, k]) => <div key={l}><span>{l}</span><Kbd>{k}</Kbd></div>)}
      </div>
    </Dialog>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const { workspaces, projects } = useStore((s) => s.snapshot);
  const s = useStore();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const page = s.page;
  const currentW = page.kind === "workspace" ? workspaces.find((w) => w.id === page.id) : undefined;
  const items = useMemo(() => {
    const base: Array<{ id: string; label: string; detail?: string; icon: React.ReactNode; run: () => void; group: string }> = [];
    for (const w of workspaces.filter((x) => x.status !== "archived")) {
      base.push({ id: w.id, group: "Workspaces", label: w.title, detail: `${projects.find((p) => p.id === w.projectId)?.name} · ${w.slug}`, icon: <GitBranch size={13} />, run: () => s.setPage({ kind: "workspace", id: w.id }) });
    }
    const a = (id: string, label: string, icon: React.ReactNode, run: () => void, detail?: string): void => void base.push({ id, group: "Actions", label, icon, run, detail });
    a("new", "New workspace", <Plus size={13} />, () => s.open({ kind: "new-workspace" }), `${mod(SHIFT)}N`);
    a("race", "Race agents", <Flag size={13} />, () => s.open({ kind: "race" }), `${mod(SHIFT)}R`);
    a("plan", "Plan from a goal", <Sparkles size={13} />, () => s.open({ kind: "plan" }), `${mod(SHIFT)}G`);
    if (currentW) {
      a("review", "Review changes", <GitPullRequest size={13} />, () => s.setReview({ path: null }), `${mod(SHIFT)}D`);
      a("term", "Open terminal", <TerminalIcon size={13} />, () => s.setInspector("terminal"), mod("J"));
      a("checks", "Open checks", <Check size={13} />, () => s.setInspector("checks"));
      a("pr", "Create pull request", <GitPullRequest size={13} />, () => s.open({ kind: "create-pr", id: currentW.id }), `${mod(SHIFT)}P`);
      a("proj", "Project settings", <SettingsIcon size={13} />, () => s.open({ kind: "project", projectId: currentW.projectId }));
    }
    const orgProject = page.kind === "org" ? page.projectId : currentW?.projectId ?? projects[0]?.id;
    for (const p of projects) {
      base.push({ id: `org-${p.id}`, group: "Teams", label: `${p.name} team`, detail: "Chief of staff, agents, tasks", icon: <Users size={13} />, run: () => s.setPage({ kind: "org", projectId: p.id, tab: s.snapshot.org[p.id]?.hasChief ? "chief" : "team" }) });
    }
    if (orgProject) {
      a("chief", "Talk to the chief of staff", <Crown size={13} />, () => s.setPage({ kind: "org", projectId: orgProject, tab: "chief" }), `${mod(SHIFT)}C`);
      a("hire", "Hire an agent", <UserPlus size={13} />, () => s.open({ kind: "hire", projectId: orgProject }));
      a("task", "New task", <ListPlus size={13} />, () => s.open({ kind: "task", projectId: orgProject }), `${mod(SHIFT)}T`);
      a("company", "Start a company", <Building2 size={13} />, () => s.open({ kind: "company", projectId: orgProject }));
      a("live", "Live agents", <Radio size={13} />, () => s.setPage({ kind: "org", projectId: orgProject, tab: "live" }));
      a("approvals", "Approvals", <Inbox size={13} />, () => s.setPage({ kind: "org", projectId: orgProject, tab: "approvals" }));
    }
    a("spend", "Spend", <CircleDollarSign size={13} />, () => s.setPage({ kind: "spend" }));
    a("insights", "Insights", <BarChart3 size={13} />, () => s.setPage({ kind: "insights" }));
    a("history", "History", <History size={13} />, () => s.setPage({ kind: "history" }));
    a("add", "Add project", <Layers size={13} />, () => void addProjectFlow(), mod("O"));
    a("settings", "Settings", <SettingsIcon size={13} />, () => s.open({ kind: "settings" }), mod(","));
    a("license", "License", <KeyRound size={13} />, () => s.open({ kind: "settings", tab: "license" }));
    a("keys", "Keyboard shortcuts", <ArrowRight size={13} />, () => s.open({ kind: "shortcuts" }), mod("/"));
    const needle = q.trim().toLowerCase();
    return needle ? base.filter((b) => `${b.label} ${b.detail ?? ""}`.toLowerCase().includes(needle)) : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, workspaces, projects, currentW]);
  useEffect(() => setI(0), [q]);
  return (
    <div className="scrim scrim-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" data-testid="palette">
        <input
          autoFocus
          value={q}
          placeholder="Jump to a workspace or run a command"
          aria-label="Command palette"
          data-testid="palette-input"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => Math.min(n + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => Math.max(n - 1, 0)); }
            if (e.key === "Enter" && items[i]) { onClose(); items[i]!.run(); }
          }}
        />
        <div className="palette-list">
          {items.map((it, n) => (
            <div key={it.id}>
              {(n === 0 || items[n - 1]!.group !== it.group) && <div className="palette-group">{it.group}</div>}
              <button className={`palette-item ${n === i ? "on" : ""}`} onMouseEnter={() => setI(n)} onClick={() => { onClose(); it.run(); }} ref={(el) => { if (n === i) el?.scrollIntoView({ block: "nearest" }); }}>
                {it.icon}<span>{it.label}</span>{it.detail && <small>{it.detail}</small>}
              </button>
            </div>
          ))}
          {items.length === 0 && <Empty title="Nothing matches" />}
        </div>
      </div>
    </div>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const open = useStore((s) => s.open);
  const close = (): void => open(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "new-workspace": return <NewWorkspaceDialog projectId={dialog.projectId} onClose={close} />;
    case "race": return <RaceDialog projectId={dialog.projectId} onClose={close} />;
    case "plan": return <PlanDialog projectId={dialog.projectId} onClose={close} />;
    case "create-pr": return <CreatePrDialog id={dialog.id} onClose={close} />;
    case "project": return <ProjectDialog projectId={dialog.projectId} onClose={close} />;
    case "settings": return <SettingsDialog tab={dialog.tab} onClose={close} />;
    case "shortcuts": return <ShortcutsDialog onClose={close} />;
    case "palette": return <Palette onClose={close} />;
    case "hire": return <HireDialog projectId={dialog.projectId} preset={dialog.preset} onClose={close} />;
    case "edit-agent": return <EditAgentDialog projectId={dialog.projectId} name={dialog.name} onClose={close} />;
    case "delegate": return <DelegateDialog projectId={dialog.projectId} agent={dialog.agent} onClose={close} />;
    case "broadcast": return <BroadcastDialog projectId={dialog.projectId} onClose={close} />;
    case "task": return <TaskDialog projectId={dialog.projectId} assignee={dialog.assignee} onClose={close} />;
    case "company": return <CompanyDialog projectId={dialog.projectId} onClose={close} />;
    case "suggest": return <SuggestDialog projectId={dialog.projectId} onClose={close} />;
    case "upgrade":
      return (
        <Dialog title={<><Trophy size={15} className="title-ic" /> CEO Pro</>} subtitle={dialog.reason} onClose={close} width={560} testId="upgrade-dialog">
          <LicensePanel />
        </Dialog>
      );
    case "confirm":
      return (
        <Dialog title={dialog.title} onClose={close} width={440} testId="confirm-dialog" footer={<>
          <Button tone="ghost" onClick={close}>Cancel</Button>
          <Button autoFocus tone={dialog.danger ? "danger" : "accent"} data-testid="confirm" onClick={() => { close(); dialog.run(); }}>{dialog.action}</Button>
        </>}>
          <p className="muted">{dialog.body}</p>
        </Dialog>
      );
    default:
      return null;
  }
}
