import { useEffect, useMemo, useState } from "react";
import { Building2, Check, Megaphone, Send, Sparkles, UserPlus, Wand2 } from "lucide-react";

import type { Agent, Company, CompanyPreview, Level, Provider, RoleTemplate, Sandbox, Suggestion, TaskPriority } from "../../shared/api";
import { LEVELS } from "../../shared/api";
import { call } from "../api";
import { mod, modelLabel, money, PROVIDER_LABEL } from "../format";
import { act, useStore } from "../store";
import { defaultModel, firstReady, ProviderSelect, Toggle } from "./Dialogs";
import { Button, Dialog, Empty, Field, Kbd, ProviderMark, Select, Spinner } from "./ui";

export const LEVEL_NAME: Record<Level, string> = { observe: "Observe", propose: "Propose", execute: "Execute", autonomous: "Autonomous" };
export const LEVEL_HINT: Record<Level, string> = {
  observe: "Reads and reports. Changes nothing.",
  propose: "Drafts changes for review. Runs no commands.",
  execute: "Edits files and runs commands on a branch.",
  autonomous: "Edits, runs commands and may merge after checks pass.",
};

export function LevelPicker({ value, onChange, levels = LEVELS }: { value: Level; onChange: (l: Level) => void; levels?: Level[] }) {
  return (
    <div className="segmented segmented-wide" role="radiogroup" aria-label="Permission level">
      {levels.map((l) => (
        <button key={l} role="radio" aria-checked={value === l} className={value === l ? "on" : ""} onClick={() => onChange(l)} title={LEVEL_HINT[l]}>{LEVEL_NAME[l]}</button>
      ))}
    </div>
  );
}

function ModelSelect({ provider, value, onChange }: { provider: Provider; value: string; onChange: (m: string) => void }) {
  const readiness = useStore((s) => s.readiness);
  const models = readiness.find((r) => r.provider === provider)?.models ?? [];
  const options = (models.includes(value) || !value ? models : [value, ...models]).map((m) => ({ value: m, label: modelLabel(m) }));
  return <Select<string> value={value} label={value ? modelLabel(value) : "Default"} options={options.length ? options : [{ value, label: modelLabel(value) || "Default" }]} onChange={onChange} />;
}

/** A budget is a number someone typed. Blank is not zero: zero means no cap. */
const budgetOf = (s: string): number | null => (/^\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : null);
const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function AgentForm({
  name, setName, role, setRole, provider, setProvider, model, setModel, level, setLevel, budget, setBudget, guardrails, setGuardrails, collaboration, setCollaboration, editing,
}: {
  name: string; setName: (v: string) => void; role: string; setRole: (v: string) => void; provider: Provider; setProvider: (p: Provider) => void; model: string; setModel: (m: string) => void;
  level: Level; setLevel: (l: Level) => void; budget: string; setBudget: (v: string) => void; guardrails: string; setGuardrails: (v: string) => void; collaboration: string; setCollaboration: (v: string) => void; editing: boolean;
}) {
  const readiness = useStore((s) => s.readiness);
  return (
    <>
      {!editing && (
        <Field label="Name" hint="Lowercase letters, digits and hyphens. The branch is ceo/ plus this name.">
          <input className="input" autoFocus value={name} data-testid="agent-name" placeholder="reviewer" onChange={(e) => setName(slug(e.target.value))} />
        </Field>
      )}
      <Field label="Role" hint="What the agent does and what done looks like. Every run starts from this brief.">
        <textarea className="input" rows={3} value={role} data-testid="agent-role" placeholder="Reviews each change for correctness and missing tests. Reports findings with file and line." onChange={(e) => setRole(e.target.value)} />
      </Field>
      <div className="form-row">
        <Field label="Agent"><ProviderSelect value={provider} onChange={(p) => { setProvider(p); setModel(defaultModel(readiness, p)); }} /></Field>
        <Field label="Model"><ModelSelect provider={provider} value={model} onChange={setModel} /></Field>
        <Field label="Budget" hint={budgetOf(budget) === null ? "Enter a dollar amount. Zero means no cap." : budgetOf(budget) === 0 ? "No cap. The agent may spend without limit." : "A hard cap in dollars. Zero means no cap."}>
          <input className="input" inputMode="decimal" value={budget} data-testid="agent-budget" onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ""))} />
        </Field>
      </div>
      <Field label="Permissions" hint={LEVEL_HINT[level]}>
        <LevelPicker value={level} onChange={setLevel} />
      </Field>
      <div className="form-row">
        <Field label="Guardrails" hint="One per line. Hard rules this agent never breaks.">
          <textarea className="input" rows={3} value={guardrails} placeholder={"Never touch migrations\nNever push"} onChange={(e) => setGuardrails(e.target.value)} />
        </Field>
        <Field label="Works with others" hint="Who to hand work to, and when to stop and ask.">
          <textarea className="input" rows={3} value={collaboration} placeholder="Hand finished work to reviewer." onChange={(e) => setCollaboration(e.target.value)} />
        </Field>
      </div>
    </>
  );
}

export function HireDialog({ projectId, preset, onClose }: { projectId: string; preset?: { name?: string; role?: string; level?: Level; isolated?: boolean; budgetUsd?: number }; onClose: () => void }) {
  const readiness = useStore((s) => s.readiness);
  const settings = useStore((s) => s.settings);
  const setPage = useStore((s) => s.setPage);
  const first = firstReady(readiness, settings?.defaultProvider);
  const [name, setName] = useState(preset?.name ?? "");
  const [role, setRole] = useState(preset?.role ?? "");
  const [provider, setProvider] = useState<Provider>(first);
  const [model, setModel] = useState(defaultModel(readiness, first));
  const [level, setLevel] = useState<Level>(preset?.level ?? "execute");
  const [budget, setBudget] = useState(String(preset?.budgetUsd ?? 5));
  const [isolated, setIsolated] = useState(preset?.isolated ?? true);
  const [guardrails, setGuardrails] = useState("");
  const [collaboration, setCollaboration] = useState("");
  const [templates, setTemplates] = useState<RoleTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => void call("roleTemplates").then(setTemplates), []);
  const ok = name.length >= 2 && role.trim().length >= 10 && budgetOf(budget) !== null && !busy;
  const submit = async (): Promise<void> => {
    if (!ok) return;
    setBusy(true);
    const a = await act(() => call("hireAgent", {
      projectId, name, role, provider, model, level, budgetUsd: budgetOf(budget)!, isolated, guardrails: lines(guardrails), collaboration,
    }), `Hired ${name}`);
    setBusy(false);
    if (a) {
      onClose();
      setPage({ kind: "org", projectId, tab: "team", agent: a.name });
    }
  };
  return (
    <Dialog
      title={<><UserPlus size={15} className="title-ic" /> Hire an agent</>}
      subtitle="A teammate with a brief, a budget and a permission level. Runs headless."
      onClose={onClose}
      width={640}
      testId="hire-dialog"
      footer={<>
        <span className="foot-left"><Kbd>{mod("↵")}</Kbd> hire</span>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" disabled={!ok} onClick={() => void submit()} data-testid="hire-submit">Hire</Button>
      </>}
    >
      <div onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} className="dialog-stack">
        {templates.length > 0 && (
          <Field label="Start from a role">
            <div className="chips chips-wrap">
              {templates.map((t) => (
                <button key={t.name} className={`chip chip-btn ${name === t.name ? "chip-on" : ""}`} onClick={() => { setName(t.name); setRole(t.role); setLevel(t.level); setIsolated(t.isolated); }}>{t.name}</button>
              ))}
            </div>
          </Field>
        )}
        <AgentForm {...{ name, setName, role, setRole, provider, setProvider, model, setModel, level, setLevel, budget, setBudget, guardrails, setGuardrails, collaboration, setCollaboration }} editing={false} />
        <Toggle label="Own branch" hint="Work lands on ceo/<name> in a separate worktree. Merge it when ready." value={isolated} onChange={setIsolated} />
      </div>
    </Dialog>
  );
}

export function EditAgentDialog({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const agent = useStore((s) => s.orgs[projectId]?.agents.find((a) => a.name === name));
  const [role, setRole] = useState(agent?.role ?? "");
  const [provider, setProvider] = useState<Provider>(agent?.provider ?? "claude");
  const [model, setModel] = useState(agent?.model ?? "");
  const [level, setLevel] = useState<Level>(agent?.level ?? "execute");
  const [budget, setBudget] = useState(String(agent?.budgetUsd ?? 0));
  const [guardrails, setGuardrails] = useState((agent?.guardrails ?? []).join("\n"));
  const [collaboration, setCollaboration] = useState(agent?.collaboration ?? "");
  const [busy, setBusy] = useState(false);
  if (!agent) return null;
  const submit = async (): Promise<void> => {
    setBusy(true);
    const b = budgetOf(budget);
    if (b === null) return;
    // Only what changed. A running agent still takes a new budget or level.
    const change: Parameters<typeof call<"updateAgent">>[1]["change"] = {};
    if (role.trim() !== agent.role) change.role = role;
    if (provider !== agent.provider) change.provider = provider;
    if (model !== agent.model) change.model = model;
    if (level !== agent.level) change.level = level;
    if (b !== agent.budgetUsd) change.budgetUsd = b;
    if (lines(guardrails).join("\n") !== agent.guardrails.join("\n")) change.guardrails = lines(guardrails);
    if (collaboration.trim() !== agent.collaboration.trim()) change.collaboration = collaboration;
    const r = await act(() => call("updateAgent", { projectId, name, change }), `Saved ${name}`);
    setBusy(false);
    if (r) onClose();
  };
  return (
    <Dialog title={`Edit ${name}`} subtitle="Brief, budget and history stay with the agent across providers." onClose={onClose} width={640} testId="edit-agent-dialog"
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="accent" disabled={busy || role.trim().length < 10 || budgetOf(budget) === null} onClick={() => void submit()} data-testid="edit-agent-save">Save</Button></>}>
      <div className="dialog-stack">
        <AgentForm name={name} setName={() => {}} {...{ role, setRole, provider, setProvider, model, setModel, level, setLevel, budget, setBudget, guardrails, setGuardrails, collaboration, setCollaboration }} editing />
      </div>
    </Dialog>
  );
}

function AgentPicker({ agents, value, onChange, allowNone }: { agents: Agent[]; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  const options = [
    ...(allowNone ? [{ value: "", label: "Unassigned", detail: "Stays queued until given to someone" }] : []),
    ...agents.map((a) => ({ value: a.name, label: a.name, icon: <ProviderMark provider={a.provider} />, detail: a.state === "running" ? `Working: ${a.doing ?? ""}` : `${PROVIDER_LABEL[a.provider]} · ${LEVEL_NAME[a.level]}` })),
  ];
  return <Select<string> value={value ?? ""} label={value || (allowNone ? "Unassigned" : "Choose an agent")} options={options} onChange={(v) => onChange(v || null)} />;
}

export function useTeam(projectId: string): Agent[] {
  const agents = useStore((s) => s.orgs[projectId]?.agents);
  return useMemo(() => (agents ?? []).filter((a) => !a.chief && !a.workspaceId), [agents]);
}

export function DelegateDialog({ projectId, agent, onClose }: { projectId: string; agent?: string; onClose: () => void }) {
  const team = useTeam(projectId);
  const setPage = useStore((s) => s.setPage);
  const [who, setWho] = useState<string | null>(agent ?? team[0]?.name ?? null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const target = team.find((a) => a.name === who);
  const submit = async (): Promise<void> => {
    if (!who || task.trim().length < 3 || busy) return;
    setBusy(true);
    const r = await act(() => call("delegate", { projectId, agent: who, task: task.trim() }));
    setBusy(false);
    if (r !== undefined) {
      onClose();
      useStore.getState().toast(r ? `${who} started` : `Queued for ${who}`, "ok");
      setPage({ kind: "org", projectId, tab: "live" });
    }
  };
  return (
    <Dialog title={<><Send size={15} className="title-ic" /> Give work</>} subtitle="Runs headless now. Spend counts against the agent's budget." onClose={onClose} width={580} testId="delegate-dialog"
      footer={<>
        <span className="foot-left"><Kbd>{mod("↵")}</Kbd> start</span>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" disabled={!who || task.trim().length < 3 || busy} onClick={() => void submit()} data-testid="delegate-submit">{target?.state === "running" ? "Queue" : "Start"}</Button>
      </>}>
      <div className="dialog-stack">
        <Field label="Agent"><AgentPicker agents={team} value={who} onChange={setWho} /></Field>
        {target?.state === "running" && <p className="muted small">{who} is busy. The task waits in the queue until the current run ends.</p>}
        <textarea className="big-input" autoFocus rows={5} value={task} data-testid="delegate-task" placeholder="What to do, and what done looks like." onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
      </div>
    </Dialog>
  );
}

export function BroadcastDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const team = useTeam(projectId);
  const [picked, setPicked] = useState<string[]>(team.map((a) => a.name));
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!picked.length || task.trim().length < 3 || busy) return;
    setBusy(true);
    const r = await act(() => call("broadcast", { projectId, task: task.trim(), agents: picked }));
    setBusy(false);
    if (r) {
      onClose();
      useStore.getState().toast(`${r.started.length} started${r.queued.length ? `, ${r.queued.length} queued` : ""}`, "ok");
      useStore.getState().setPage({ kind: "org", projectId, tab: "live" });
    }
  };
  return (
    <Dialog title={<><Megaphone size={15} className="title-ic" /> Broadcast</>} subtitle="The same task to several agents at once. Each run is separate." onClose={onClose} width={580} testId="broadcast-dialog"
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="accent" disabled={!picked.length || task.trim().length < 3 || busy} onClick={() => void submit()} data-testid="broadcast-submit">Send to {picked.length}</Button></>}>
      <div className="dialog-stack">
        <textarea className="big-input" autoFocus rows={4} value={task} placeholder="Report the three riskiest files in this repository, with a reason for each." onChange={(e) => setTask(e.target.value)} />
        <div className="chips chips-wrap">
          {team.map((a) => {
            const on = picked.includes(a.name);
            return (
              <button key={a.name} className={`chip chip-btn ${on ? "chip-on" : ""}`} onClick={() => setPicked(on ? picked.filter((x) => x !== a.name) : [...picked, a.name])}>
                <ProviderMark provider={a.provider} size={6} /> {a.name}
              </button>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}

export function TaskDialog({ projectId, assignee, onClose }: { projectId: string; assignee?: string; onClose: () => void }) {
  const team = useTeam(projectId);
  const license = useStore((s) => s.license);
  const [title, setTitle] = useState("");
  const [who, setWho] = useState<string | null>(assignee ?? null);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [checks, setChecks] = useState("");
  const [samples, setSamples] = useState(1);
  const [provider, setProvider] = useState<Provider | "">("");
  const [sandbox, setSandbox] = useState<Sandbox>("local");
  const [route, setRoute] = useState<Array<{ provider: Provider; model: string; why: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (title.trim().length < 6) return setRoute([]);
    const t = setTimeout(() => void call("routeTask", { projectId, title }).then(setRoute).catch(() => setRoute([])), 300);
    return () => clearTimeout(t);
  }, [title, projectId]);
  const submit = async (run: boolean): Promise<void> => {
    if (title.trim().length < 3 || busy) return;
    if (samples > 1 && !license?.limits.attempts) {
      useStore.getState().open({ kind: "upgrade", reason: "Several attempts per task are part of Pro." });
      return;
    }
    setBusy(true);
    const t = await act(() => call("addTask", { projectId, title: title.trim(), assignee: who, priority, checks: lines(checks), samples, provider: provider || null, sandbox: sandbox === "local" ? null : sandbox, run: run && !!who }));
    setBusy(false);
    if (t) {
      useStore.getState().toast(t.status === "running" || t.status === "verifying" ? "Task started" : run && who ? `Queued. ${who} starts it once the current run ends.` : "Task queued", "ok");
      onClose();
    }
  };
  return (
    <Dialog title="New task" subtitle="Queued work. A task with checks is done only when a check passes." onClose={onClose} width={620} testId="task-dialog"
      footer={<>
        <span className="foot-left"><Kbd>{mod("↵")}</Kbd> queue</span>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={title.trim().length < 3 || busy} onClick={() => void submit(false)} data-testid="task-queue">Queue</Button>
        <Button tone="accent" disabled={title.trim().length < 3 || busy || !who} onClick={() => void submit(true)} data-testid="task-start">Start now</Button>
      </>}>
      <div className="dialog-stack" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(false); }}>
        <textarea className="big-input" autoFocus rows={3} value={title} data-testid="task-title" placeholder="Fix the flaky retry test. Done means the suite passes ten runs in a row." onChange={(e) => setTitle(e.target.value)} />
        <div className="form-row">
          <Field label="Assignee"><div data-testid="task-assignee"><AgentPicker agents={team} value={who} onChange={setWho} allowNone /></div></Field>
          <Field label="Priority">
            <div className="segmented segmented-wide">
              {(["high", "normal", "low"] as TaskPriority[]).map((p) => <button key={p} className={priority === p ? "on" : ""} onClick={() => setPriority(p)}>{p[0]!.toUpperCase() + p.slice(1)}</button>)}
            </div>
          </Field>
          <Field label="Run on">
            <Select<string> value={provider} label={provider ? PROVIDER_LABEL[provider] : "The agent's own"} options={[{ value: "", label: "The agent's own" }, ...(["claude", "codex", "gemini"] as Provider[]).map((p) => ({ value: p, label: PROVIDER_LABEL[p], icon: <ProviderMark provider={p} /> }))]} onChange={(v) => setProvider(v as Provider | "")} />
          </Field>
        </div>
        {route.length > 0 && (
          <p className="muted small route"><Wand2 size={12} /> The router favours {route.slice(0, 2).map((r) => `${PROVIDER_LABEL[r.provider]} ${modelLabel(r.model)}`).join(", then ")} for this kind of work.</p>
        )}
        <div className="form-row">
          <Field label="Checks" hint="One per line. A shell command such as npm test. Or judge: followed by a rubric.">
            <textarea className="input code-input" rows={3} value={checks} data-testid="task-checks" placeholder={"npm test\njudge: the change has a regression test"} onChange={(e) => setChecks(e.target.value)} />
          </Field>
          <Field label="Runs in" hint="Docker and SSH need setting up. See Integrations.">
            <Select<Sandbox> value={sandbox} label={{ local: "This Mac", docker: "A Docker container", ssh: "An SSH host" }[sandbox]} options={[{ value: "local", label: "This Mac" }, { value: "docker", label: "A Docker container" }, { value: "ssh", label: "An SSH host" }]} onChange={setSandbox} />
          </Field>
          <Field label="Attempts" hint="Several attempts run side by side. The best passing one is kept.">
            <div className="segmented segmented-wide">
              {[1, 2, 3, 5].map((n) => <button key={n} className={samples === n ? "on" : ""} onClick={() => setSamples(n)}>{n}</button>)}
            </div>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

export function CompanyDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [list, setList] = useState<Company[] | null>(null);
  const [id, setId] = useState<string>("");
  const [scale, setScale] = useState(1);
  const [preview, setPreview] = useState<CompanyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void call("companies").then((c) => { setList(c); setId(c[0]?.id ?? ""); }), []);
  useEffect(() => {
    if (!id) return;
    setPreview(null);
    void act(() => call("previewCompany", { projectId, id, scale })).then((p) => p && setPreview(p));
  }, [id, scale, projectId]);
  const hire = async (): Promise<void> => {
    setBusy(true);
    const r = await act(() => call("hireCompany", { projectId, id, scale }));
    setBusy(false);
    if (r) {
      useStore.getState().toast(r.message, "ok");
      onClose();
      useStore.getState().setPage({ kind: "org", projectId, tab: "team" });
    }
  };
  const seats = preview?.seats.filter((s) => !s.skip) ?? [];
  return (
    <Dialog title={<><Building2 size={15} className="title-ic" /> Start a company</>} subtitle="A whole team on several providers, with a chief of staff, hired at once." onClose={onClose} width={720} testId="company-dialog"
      footer={<>
        <span className="foot-left muted small">{preview ? `${seats.length} agents. Combined cap ${money(preview.totalCapUsd)}.` : ""}</span>
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
        <Button tone="accent" disabled={!preview || busy} onClick={() => void hire()} data-testid="company-hire">Hire the team</Button>
      </>}>
      {!list ? <div className="center"><Spinner size={16} /></div> : (
        <div className="company">
          <div className="company-list">
            {list.map((c) => (
              <button key={c.id} className={`company-item ${id === c.id ? "on" : ""}`} onClick={() => setId(c.id)}>
                <b>{c.title}</b><small>{c.tagline}</small>
              </button>
            ))}
          </div>
          <div className="company-preview">
            <div className="form-row">
              <Field label="Size" hint="Each seat becomes this many agents.">
                <div className="segmented segmented-wide">{[1, 2, 3, 5].map((n) => <button key={n} className={scale === n ? "on" : ""} onClick={() => setScale(n)}>{n}×</button>)}</div>
              </Field>
            </div>
            {!preview ? <div className="center"><Spinner size={14} /></div> : (
              <>
                {preview.note && <p className="muted small">{preview.note}</p>}
                {preview.chief.hire && <div className="seat"><ProviderMark provider={preview.chief.provider} /><b>{preview.chief.name}</b><span className="muted small">Chief of staff · hires and gives out work</span></div>}
                {preview.seats.map((s) => (
                  <div key={s.name} className={`seat ${s.skip ? "seat-skip" : ""}`} title={s.brief}>
                    <ProviderMark provider={s.provider} />
                    <b>{s.name}</b>
                    <span className="muted small seat-brief">{s.skip ?? s.brief}</span>
                    <span className="badge">{LEVEL_NAME[s.level]}</span>
                    <span className="muted small">{money(s.budgetUsd)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function SuggestDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [s, setS] = useState<Suggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call("suggestTeam", { projectId }).then((x) => { setS(x); setPicked(x.agents.map((a) => a.name)); }).catch((e: Error) => setError(e.message));
  }, [projectId]);
  const hire = async (): Promise<void> => {
    if (!s) return;
    setBusy(true);
    let n = 0;
    for (const a of s.agents.filter((x) => picked.includes(x.name))) {
      const r = await act(() => call("hireAgent", { projectId, name: a.name, role: a.role, provider: a.provider, model: a.model, level: a.level, budgetUsd: a.budgetUsd, isolated: a.isolated, guardrails: [], collaboration: "" }));
      if (r) n++;
    }
    setBusy(false);
    if (n) useStore.getState().toast(`Hired ${n} agent${n === 1 ? "" : "s"}`, "ok");
    onClose();
  };
  return (
    <Dialog title={<><Sparkles size={15} className="title-ic" /> Suggested team</>} subtitle="Read from this repository and from recent Claude Code and Codex sessions on this machine." onClose={onClose} width={660} testId="suggest-dialog"
      footer={<><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="accent" disabled={!s || !picked.length || busy} onClick={() => void hire()}>Hire {picked.length}</Button></>}>
      {error ? <Empty title="No suggestion">{error}</Empty> : !s ? <div className="center"><Spinner size={16} /></div> : s.agents.length === 0 ? <Empty title="Nothing to suggest yet">{s.summary.join(" ")}</Empty> : (
        <div className="dialog-stack">
          {s.summary.length > 0 && <p className="muted small">{s.summary.join(" ")}</p>}
          {s.agents.map((a) => {
            const on = picked.includes(a.name);
            return (
              <button key={a.name} className={`suggest ${on ? "on" : ""}`} onClick={() => setPicked(on ? picked.filter((x) => x !== a.name) : [...picked, a.name])}>
                <span className="suggest-check">{on && <Check size={12} />}</span>
                <span className="suggest-main">
                  <span className="suggest-top"><ProviderMark provider={a.provider} /><b>{a.name}</b><span className="badge">{LEVEL_NAME[a.level]}</span><span className="muted small">{money(a.budgetUsd)}</span></span>
                  <span className="small">{a.role}</span>
                  {a.why && <span className="muted small">{a.why}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
