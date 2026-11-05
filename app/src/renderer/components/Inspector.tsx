import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  ShieldAlert, ShieldCheck, Check, CheckCircle2, ChevronRight, CircleDashed, CircleX, Eye, ExternalLink, FileText, Folder, GitMerge, GitPullRequest, ListTodo, MessageSquare, Play, Plus, RefreshCw, Search, Send, Square, X,
} from "lucide-react";

import type { ChecksReport, FileEntry, RecordEntry, ScriptKind, ScriptState, SearchHit, Todo, Workspace } from "../../shared/api";
import { bridge, call, desktop } from "../api";
import { ago, count, mod, money, SHIFT, shortBase } from "../format";
import { highlightLine, languageOf, renderMarkdown } from "../markdown";
import { act, useStore, type InspectorTab } from "../store";
import { useDiff } from "./Review";
import { Button, Empty, Spinner } from "./ui";

function sendToAgent(w: Workspace, label: string, text: string, message: string): void {
  const s = useStore.getState();
  const tab = s.activeTab[w.id] ?? w.tabs[0]!.id;
  void act(() => call("send", { id: w.id, tabId: tab, text: message, attachments: text ? [{ kind: "text", label, text }] : [] }));
}

function Changes({ w }: { w: Workspace }) {
  const { diff } = useDiff(w.id, null);
  const setReview = useStore((s) => s.setReview);
  const files = diff?.files ?? [];
  if (!diff) return <div className="center"><Spinner size={16} /></div>;
  if (files.length === 0) {
    return <Empty icon={<FileText size={18} />} title="No changes yet">Files the agent changes show up here.</Empty>;
  }
  const viewed = files.filter((f) => w.viewed[f.path] === f.hash).length;
  return (
    <div className="pane" data-testid="changes">
      <div className="pane-bar">
        <span className="muted">{count(files.length, "file")} · <em className="add">+{files.reduce((n, f) => n + f.added, 0)}</em> <em className="del">−{files.reduce((n, f) => n + f.removed, 0)}</em></span>
        <Button size="sm" tone="accent" icon={<Eye size={13} />} onClick={() => setReview({ path: null })} data-testid="open-review">Review</Button>
      </div>
      <div className="pane-scroll">
        {files.map((f) => (
          <button key={f.path} className="file-row" onClick={() => setReview({ path: f.path })} title={f.path}>
            {w.viewed[f.path] === f.hash ? <CheckCircle2 size={13} className="rf-check" /> : <span className={`fdot fdot-${f.status}`} />}
            <span className="file-name">{f.path.split("/").pop()}</span>
            <span className="file-dir">{f.path.split("/").slice(0, -1).join("/")}</span>
            <span className="rf-stat"><em className="add">+{f.added}</em> <em className="del">−{f.removed}</em></span>
          </button>
        ))}
        {diff.commits.length > 0 && (
          <div className="commits">
            <h4>Commits</h4>
            {diff.commits.map((c) => (
              <div key={c.sha} className="commit-row" title={c.sha}><code>{c.short}</code> <span>{c.subject.replace(/^ceo\([^)]*\):\s*/, "")}</span></div>
            ))}
          </div>
        )}
      </div>
      <div className="pane-foot muted">{viewed} of {files.length} viewed</div>
    </div>
  );
}

type Tree = { dirs: Map<string, Tree>; files: FileEntry[] };
function buildTree(files: FileEntry[]): Tree {
  const root: Tree = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p)!;
    }
    node.files.push(f);
  }
  return root;
}
function TreeView({ node, depth, onOpen, current }: { node: Tree; depth: number; onOpen: (p: string) => void; current: string | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <>
      {[...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => (
        <div key={name}>
          <button className="tree-row" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setOpen({ ...open, [name]: !open[name] })}>
            <ChevronRight size={11} className={open[name] ? "rot90" : ""} /> <Folder size={12} className="muted" /> <span>{name}</span>
          </button>
          {open[name] && <TreeView node={child} depth={depth + 1} onOpen={onOpen} current={current} />}
        </div>
      ))}
      {node.files.map((f) => (
        <button key={f.path} className={`tree-row ${current === f.path ? "tree-on" : ""} ${f.changed ? "tree-changed" : ""}`} style={{ paddingLeft: 24 + depth * 12 }} onClick={() => onOpen(f.path)}>
          <FileText size={12} className="muted" /> <span>{f.path.split("/").pop()}</span>
        </button>
      ))}
    </>
  );
}

function Files({ w }: { w: Workspace }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [content, setContent] = useState<{ text: string | null; binary: boolean; tooLarge: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [rendered, setRendered] = useState(true);
  useEffect(() => {
    void call("files", { id: w.id }).then(setFiles).catch(() => setFiles([]));
  }, [w.id, w.git.files]);
  useEffect(() => {
    if (!query.trim()) { setHits(null); return; }
    const t = setTimeout(() => void call("searchFiles", { id: w.id, query }).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [query, w.id]);
  const open = (p: string): void => {
    setCurrent(p);
    setContent(null);
    void act(() => call("readFile", { id: w.id, path: p })).then((c) => c && setContent(c));
  };
  const tree = useMemo(() => buildTree(files ?? []), [files]);
  if (current) {
    const isMd = current.toLowerCase().endsWith(".md");
    const lang = languageOf(current);
    return (
      <div className="pane">
        <div className="pane-bar">
          <Button tone="ghost" size="sm" icon={<ChevronRight size={13} className="rot180" />} onClick={() => setCurrent(null)}>Files</Button>
          <span className="pane-title" title={current}>{current}</span>
          {isMd && <Button tone="ghost" size="sm" onClick={() => setRendered(!rendered)}>{rendered ? "Source" : "Preview"}</Button>}
        </div>
        <div className="pane-scroll">
          {!content && <div className="center"><Spinner size={16} /></div>}
          {content?.binary && <Empty title="Binary file" />}
          {content?.tooLarge && <Empty title="Too large to preview" />}
          {content?.text != null && (isMd && rendered
            ? <div className="md md-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(content.text) }} />
            : <pre className="code-view">{content.text.split("\n").map((l, i) => (
                <div className="code-line" key={i}><span className="dl-n">{i + 1}</span><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightLine(l, lang) || "&nbsp;" }} /></div>
              ))}</pre>)}
        </div>
      </div>
    );
  }
  return (
    <div className="pane">
      <div className="pane-bar">
        <div className="search search-flat">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search across files" aria-label="Search across files" />
        </div>
      </div>
      <div className="pane-scroll">
        {hits ? (
          hits.length ? hits.map((h, i) => (
            <button key={i} className="hit-row" onClick={() => open(h.path)}>
              <span className="hit-path">{h.path}:{h.line}</span>
              <code>{h.text.trim()}</code>
            </button>
          )) : <Empty title="No matches" />
        ) : files ? <TreeView node={tree} depth={0} onOpen={open} current={current} /> : <div className="center"><Spinner size={16} /></div>}
      </div>
    </div>
  );
}

/** The merge-readiness report. It reloads as soon as anything it depends on changes, and every 20 seconds for CI. */
export function useChecks(w: Workspace, enabled: boolean): { report: ChecksReport | null; refresh: () => void; loading: boolean } {
  const id = w.id;
  const [report, setReport] = useState<ChecksReport | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(() => {
    setLoading(true);
    void call("checks", { id }).then(setReport).catch(() => null).finally(() => setLoading(false));
  }, [id]);
  const signal = [w.mergedAt, w.pr?.state, w.pr?.number, w.git.files, w.git.added, w.git.removed, w.git.ahead, w.git.behind, w.git.dirty, w.git.conflicts.length, w.runningTabs.length, w.status].join();
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, [refresh, enabled, signal]);
  return { report, refresh, loading };
}

function Checks({ w }: { w: Workspace }) {
  const { report, refresh, loading } = useChecks(w, true);
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === w.projectId));
  const [newTodo, setNewTodo] = useState("");
  const setTodos = (todos: Todo[]): void => void act(() => call("setTodos", { id: w.id, todos }));
  const check = project?.config.check.trim();
  const g = report?.git;
  return (
    <div className="pane" data-testid="checks">
      <div className="pane-bar">
        <span className="pane-title">Ready to merge?</span>
        <Button tone="ghost" size="sm" icon={loading ? <Spinner size={11} /> : <RefreshCw size={12} />} aria-label="Refresh" onClick={refresh} />
      </div>
      <div className="pane-scroll checks">
        {report && <NextCard w={w} report={report} />}
        <section>
          <h4>Branch</h4>
          {g ? (
            <>
              <Line ok={g.conflicts.length === 0} label={g.conflicts.length ? `${g.conflicts.length} conflict${g.conflicts.length === 1 ? "" : "s"} with ${shortBase(w.baseRef)}` : `No conflicts with ${shortBase(w.baseRef)}`} />
              {g.conflicts.map((c) => <div className="line-sub" key={c}>{c}</div>)}
              <Line ok={g.behind === 0} warn label={g.behind ? `${g.behind} commit${g.behind === 1 ? "" : "s"} behind ${shortBase(w.baseRef)}` : "Up to date with the base"} action={g.behind ? { label: "Update", run: () => void act(async () => { const r = await call("updateFromBase", { id: w.id }); if (r.conflicts.length) useStore.getState().toast(`${r.conflicts.length} conflicts. Ask the agent to resolve them.`, "error"); refresh(); }) } : undefined} />
              <Line ok={!g.dirty} warn label={g.dirty ? "Uncommitted changes" : "All work committed"} action={g.dirty ? { label: "Commit", run: () => void act(async () => { await call("commit", { id: w.id, message: w.title }); refresh(); }, "Committed") } : undefined} />
            </>
          ) : <Spinner size={12} />}
        </section>
        <section>
          <h4>Project check</h4>
          {check ? (
            <>
              <Line
                ok={w.checkResult?.pass}
                pending={w.scripts.check}
                none={!w.checkResult && !w.scripts.check}
                label={w.scripts.check ? `Running ${check}` : w.checkResult ? w.checkResult.detail : check}
                action={{ label: w.checkResult ? "Run again" : "Run", run: () => void act(() => call("runScript", { id: w.id, kind: "check" })) }}
              />
            </>
          ) : (
            <p className="muted small">No check set. <button className="link" onClick={() => useStore.getState().open({ kind: "project", projectId: w.projectId })}>Add a command</button> such as npm test.</p>
          )}
        </section>
        {report && (
          <section>
            <h4>Pull request</h4>
            {report.pr ? (
              <div className="pr-card">
                <button className="link pr-link" onClick={() => void desktop.openExternal(report.pr!.url)}>
                  <GitPullRequest size={13} /> #{report.pr.number} <ExternalLink size={11} />
                </button>
                <span className={`badge badge-${report.pr.state.toLowerCase()}`}>{report.pr.isDraft ? "Draft" : report.pr.state.toLowerCase()}</span>
                {report.pr.reviewDecision && <span className="badge">{report.pr.reviewDecision.replace(/_/g, " ").toLowerCase()}</span>}
              </div>
            ) : report.ghReady ? <p className="muted small">None yet.</p> : <p className="muted small">{report.ghReason}</p>}
          </section>
        )}
        {report && report.runs.length > 0 && (
          <section>
            <h4>CI</h4>
            {report.runs.map((r) => (
              <Line
                key={r.name}
                ok={r.state === "pass"}
                pending={r.state === "running"}
                none={r.state === "skipped"}
                label={r.name}
                link={r.url}
                action={r.state === "fail" ? { label: "Send to agent", run: () => void act(async () => { const log = await call("failureLog", { id: w.id, name: r.name }); sendToAgent(w, `Failing check: ${r.name}`, log, `The check "${r.name}" is failing. Find the cause and fix it.`); }) } : undefined}
              />
            ))}
          </section>
        )}
        {report && report.reviews.length > 0 && (
          <section>
            <h4>Review comments</h4>
            {report.reviews.map((n) => (
              <div className="review-note" key={n.id}>
                <div className="review-note-head"><MessageSquare size={12} /> <b>{n.author}</b>{n.path && <span className="muted"> {n.path}{n.line ? `:${n.line}` : ""}</span>}</div>
                <p>{n.body}</p>
              </div>
            ))}
            <Button size="sm" icon={<Send size={12} />} onClick={() => sendToAgent(w, "Review comments", report.reviews.map((n) => `${n.author}${n.path ? ` on ${n.path}${n.line ? `:${n.line}` : ""}` : ""}: ${n.body}`).join("\n\n"), "Address these review comments.")}>Send all to agent</Button>
          </section>
        )}
        <section>
          <h4><ListTodo size={12} /> Todos</h4>
          {w.todos.map((t) => (
            <div className={`todo ${t.done ? "todo-done" : ""}`} key={t.id}>
              <button className="todo-box" aria-label={t.done ? "Mark open" : "Mark done"} onClick={() => setTodos(w.todos.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))}>{t.done && <Check size={11} />}</button>
              <span>{t.text}</span>
              <button className="todo-del" aria-label="Delete" onClick={() => setTodos(w.todos.filter((x) => x.id !== t.id))}><X size={12} /></button>
            </div>
          ))}
          <form className="todo-add" onSubmit={(e) => { e.preventDefault(); if (newTodo.trim()) { setTodos([...w.todos, { id: String(Date.now()), text: newTodo.trim(), done: false }]); setNewTodo(""); } }}>
            <Plus size={13} className="muted" />
            <input value={newTodo} onChange={(e) => setNewTodo(e.target.value)} placeholder="Add a todo" aria-label="Add a todo" />
          </form>
        </section>
      </div>
    </div>
  );
}

function Line({ ok, warn, pending, none, label, action, link }: { ok?: boolean; warn?: boolean; pending?: boolean; none?: boolean; label: string; action?: { label: string; run: () => void }; link?: string | null }) {
  const icon = pending ? <Spinner size={12} /> : none ? <CircleDashed size={13} className="muted" /> : ok ? <CheckCircle2 size={13} className="ok" /> : warn ? <CircleDashed size={13} className="warn" /> : <CircleX size={13} className="del" />;
  return (
    <div className="line">
      {icon}
      {link ? <button className="line-label link" onClick={() => void desktop.openExternal(link)}>{label}</button> : <span className="line-label">{label}</span>}
      {action && <Button size="sm" tone="ghost" onClick={action.run}>{action.label}</Button>}
    </div>
  );
}

export function runNextAction(w: Workspace, report: ChecksReport): void {
  const s = useStore.getState();
  switch (report.next) {
    case "create-pr":
      s.open({ kind: "create-pr", id: w.id });
      break;
    case "merge":
      s.open({ kind: "confirm", title: `Merge #${report.pr?.number}?`, body: "Squash and merge through GitHub.", action: "Merge", run: () => void act(() => call("mergePr", { id: w.id, method: "squash" }), "Merged") });
      break;
    case "merge-local":
      s.open({
        kind: "confirm", title: `Merge into ${shortBase(w.baseRef)}?`, body: `${w.branch} merges into the main checkout on this machine.`, action: "Merge",
        run: () => void act(async () => {
          const r = await call("mergeLocal", { id: w.id });
          if (r.conflicts.length) s.toast(`${r.conflicts.length} files conflict. Ask the agent to update from the base.`, "error");
          else s.toast(`Merged into ${shortBase(w.baseRef)}`, "ok");
        }),
      });
      break;
    case "resolve-conflicts":
      sendToAgent(w, "", "", `This branch conflicts with ${w.baseRef} in: ${report.git.conflicts.join(", ")}. Merge ${w.baseRef} into this branch, resolve each conflict correctly, run the tests and commit.`);
      break;
    case "fix-checks":
      s.setInspector("checks");
      break;
    case "respond":
      sendToAgent(w, "Review comments", report.reviews.map((n) => `${n.author}${n.path ? ` on ${n.path}${n.line ? `:${n.line}` : ""}` : ""}: ${n.body}`).join("\n\n"), "Address these review comments.");
      break;
    case "update":
      void act(() => call("commit", { id: w.id, message: w.title }), "Committed");
      break;
    case "archive":
      void act(() => call("archiveWorkspace", { id: w.id }), `Archived ${w.title}`);
      break;
    default:
      break;
  }
}

function NextCard({ w, report }: { w: Workspace; report: ChecksReport }) {
  const icon = report.next === "merge" || report.next === "merge-local" ? <GitMerge size={14} /> : report.next === "create-pr" ? <GitPullRequest size={14} /> : null;
  const actionable = report.next !== "wait" && report.next !== "start";
  return (
    <div className={`next next-${report.next}`} data-testid="next-action">
      <div>
        <div className="next-label">{report.nextLabel}</div>
        <div className="next-detail">{report.nextDetail}</div>
      </div>
      {actionable && <Button tone="accent" size="sm" icon={icon} onClick={() => runNextAction(w, report)} data-testid="next-action-btn">{report.nextLabel}</Button>}
    </div>
  );
}

const THEME_DARK = { background: "#00000000", foreground: "#d4d7dc", cursor: "#2dd4a7", selectionBackground: "#2dd4a744", black: "#1b1e23", brightBlack: "#5c6370", red: "#ef6f6c", green: "#59c28b", yellow: "#e5c07b", blue: "#6d9eff", magenta: "#c58af9", cyan: "#4fc3c7", white: "#d4d7dc", brightWhite: "#ffffff" };
const THEME_LIGHT = { background: "#00000000", foreground: "#2b2f36", cursor: "#0f9d7a", selectionBackground: "#0f9d7a33", black: "#2b2f36", brightBlack: "#7a808a", red: "#c9403b", green: "#1f8a5b", yellow: "#a87a0f", blue: "#2f66d0", magenta: "#8f4bd0", cyan: "#16808a", white: "#e9eaec", brightWhite: "#ffffff" };

export function TerminalView({ terminalId, initial }: { terminalId: string; initial?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dark = document.documentElement.dataset.resolved !== "light";
    const term = new XTerm({ fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace", fontSize: 12, lineHeight: 1.25, cursorBlink: true, allowTransparency: true, theme: dark ? THEME_DARK : THEME_LIGHT, scrollback: 5000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();
    let closed = false;
    void call("terminalOpen", { id: terminalId, cols: term.cols, rows: term.rows }).then((r) => {
      if (closed) return;
      if (r.backlog) term.write(r.backlog);
      if (initial) void call("terminalInput", { terminalId, data: initial });
    }).catch((e: Error) => term.write(`\r\n${e.message}\r\n`));
    const off = bridge.on((e) => {
      if (e.type === "terminal" && e.id === terminalId) term.write(e.data);
      if (e.type === "terminal-exit" && e.id === terminalId) term.write(`\r\n[Shell exited with ${e.code}]\r\n`);
    });
    const input = term.onData((data) => void call("terminalInput", { terminalId, data }));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void call("terminalResize", { terminalId, cols: term.cols, rows: term.rows });
      } catch {
        /* the element left the page mid-frame */
      }
    });
    ro.observe(host.current!);
    term.focus();
    return () => {
      closed = true;
      off();
      input.dispose();
      ro.disconnect();
      term.dispose();
    };
    // The terminal lives as long as its id. A new first line never restarts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);
  return <div className="term" ref={host} data-testid="terminal" />;
}

function RecordPane({ w }: { w: Workspace }) {
  const [r, setR] = useState<{ entries: RecordEntry[]; ok: boolean; detail: string } | null>(null);
  useEffect(() => {
    void call("record", { id: w.id }).then(setR).catch(() => setR({ entries: [], ok: false, detail: "This workspace has no record yet." }));
  }, [w.id, w.updatedAt]);
  if (!r) return <div className="center"><Spinner size={16} /></div>;
  return (
    <div className="pane" data-testid="record">
      <div className={`record-head ${r.ok ? "" : "record-bad"}`}>
        {r.ok ? <ShieldCheck size={14} className="ok" /> : <ShieldAlert size={14} className="del" />}
        <span>{r.detail}</span>
      </div>
      <div className="pane-scroll record">
        {r.entries.map((e) => (
          <div className="rec" key={e.seq}>
            <span className={`rec-dot rec-${e.type}`} />
            <div className="rec-main">
              <div className="rec-top"><b title={e.title}>{e.title}</b>{e.costUsd !== null && <em>{money(e.costUsd)}</em>}</div>
              {e.detail && <div className="rec-detail" title={e.detail}>{e.detail}</div>}
              <div className="rec-meta">#{e.seq} · {ago(e.ts)} · {e.hash}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Run({ w }: { w: Workspace }) {
  const project = useStore((s) => s.snapshot.projects.find((p) => p.id === w.projectId));
  const [kind, setKind] = useState<ScriptKind>("run");
  const [state, setState] = useState<ScriptState | null>(null);
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let alive = true;
    void call("scriptState", { id: w.id, kind }).then((s) => alive && setState(s));
    const off = bridge.on((e) => {
      if (e.type === "script" && e.workspaceId === w.id && e.kind === kind) setState((s) => (s ? { ...s, log: (s.log + e.data).slice(-200000) } : s));
      if (e.type === "script-state" && e.workspaceId === w.id && e.kind === kind) setState((s) => ({ log: e.running && !s?.running ? "" : (s?.log ?? ""), running: e.running, code: e.code, url: e.url }));
    });
    return () => {
      alive = false;
      off();
    };
  }, [w.id, kind]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [state?.log]);
  const command = project ? (kind === "run" ? project.config.run : kind === "setup" ? project.config.setup : kind === "check" ? project.config.check : project.config.archive) : "";
  return (
    <div className="pane" data-testid="run">
      <div className="pane-bar">
        <div className="segmented">
          {(["run", "setup", "check"] as ScriptKind[]).map((k) => <button key={k} className={k === kind ? "on" : ""} onClick={() => setKind(k)}>{k[0]!.toUpperCase() + k.slice(1)}</button>)}
        </div>
        <span className="df-spacer" />
        {state?.url && <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => void desktop.openExternal(state.url!)}>Open</Button>}
        {state?.running
          ? <Button size="sm" icon={<Square size={11} fill="currentColor" />} onClick={() => void act(() => call("stopScript", { id: w.id, kind }))}>Stop</Button>
          : <Button size="sm" tone="accent" icon={<Play size={12} />} disabled={!command.trim()} onClick={() => void act(() => call("runScript", { id: w.id, kind }))} data-testid="run-script">{kind === "run" ? "Run" : "Run again"}</Button>}
      </div>
      {!command.trim() ? (
        <Empty icon={<Play size={18} />} title={`No ${kind} script`} action={<Button size="sm" onClick={() => useStore.getState().open({ kind: "project", projectId: w.projectId })}>Project settings</Button>}>
          Port {w.port} is reserved for this workspace, as $CEO_PORT.
        </Empty>
      ) : (
        <>
          <div className="script-cmd"><code>{command}</code>{state?.code != null && !state.running && <span className={state.code === 0 ? "ok" : "del"}>exited {state.code}</span>}</div>
          <pre className="log" ref={log} data-testid="script-log">{state?.log.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") || "No output yet."}</pre>
        </>
      )}
    </div>
  );
}

export function Inspector({ w }: { w: Workspace }) {
  const tab = useStore((s) => s.inspector);
  const setTab = useStore((s) => s.setInspector);
  const tabs: Array<{ id: InspectorTab; label: string; count?: number; title?: string }> = [
    { id: "changes", label: "Changes", count: w.git.files, title: `Review · ${mod(SHIFT)}D` },
    { id: "files", label: "Files" },
    { id: "checks", label: "Checks" },
    { id: "terminal", label: "Terminal", title: mod("J") },
    { id: "run", label: "Run", title: mod("R") },
    { id: "record", label: "Record", title: "The ledger for this workspace" },
  ];
  return (
    <aside className="inspector" data-testid="inspector">
      <div className="insp-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} title={t.title} className={`insp-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)} data-testid={`insp-${t.id}`}>
            {t.label}{t.count ? <span className="insp-count">{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {w.status === "archived" ? (
          <Empty title="This workspace is archived">Restore it to see its files.</Empty>
        ) : (
          <>
            {tab === "changes" && <Changes w={w} />}
            {tab === "files" && <Files w={w} />}
            {tab === "checks" && <Checks w={w} />}
            {tab === "terminal" && <TerminalView key={w.id} terminalId={w.id} />}
            {tab === "run" && <Run w={w} />}
            {tab === "record" && <RecordPane w={w} />}
          </>
        )}
      </div>
    </aside>
  );
}
