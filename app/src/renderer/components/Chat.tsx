import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp, ChevronRight, FileText, MessageSquare, ShieldAlert, Square, TerminalSquare, Wrench, X, Plus, RotateCcw, Hammer, ListChecks,
} from "lucide-react";

import type { ChatAttachment, ChatItem, ChatTab, FileEntry, Mode, Provider, Workspace } from "../../shared/api";
import { call } from "../api";
import { duration, modelLabel, money, mod, PROVIDER_LABEL } from "../format";
import { renderMarkdown } from "../markdown";
import { act, useStore } from "../store";
import { Button, Empty, Kbd, ProviderMark, Select, Spinner } from "./ui";

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

type Group = { kind: "tools"; id: string; items: Array<Extract<ChatItem, { kind: "tool" | "denied" }>> } | ChatItem;

function groupItems(items: ChatItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    if (it.kind === "tool" || it.kind === "denied") {
      const last = out[out.length - 1];
      if (last && last.kind === "tools") last.items.push(it);
      else out.push({ kind: "tools", id: it.id, items: [it] });
    } else if (it.kind !== "assistant" || it.text.length > 0) {
      out.push(it);
    }
  }
  return out;
}

function Tools({ items, running }: { items: Array<Extract<ChatItem, { kind: "tool" | "denied" }>>; running: boolean }) {
  const [open, setOpen] = useState(false);
  const denied = items.filter((i) => i.kind === "denied").length;
  const last = items[items.length - 1]!;
  return (
    <div className="tools">
      <button className="tools-head" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={open ? "rot90" : ""} />
        {running ? <Spinner size={11} /> : <Wrench size={12} />}
        <span className="tools-count">{items.length} {items.length === 1 ? "action" : "actions"}</span>
        {denied > 0 && <span className="tools-denied"><ShieldAlert size={11} /> {denied} blocked</span>}
        {!open && <span className="tools-last">{last.kind === "tool" ? last.summary || last.name : last.tool}</span>}
      </button>
      {open && (
        <ul className="tools-list">
          {items.map((i) =>
            i.kind === "tool" ? (
              <li key={i.id}><b>{i.name}</b> <span>{i.summary}</span></li>
            ) : (
              <li key={i.id} className="tools-denied-row"><ShieldAlert size={11} /> <b>{i.tool}</b> <span>blocked by this workspace's permissions</span></li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function AttachmentChip({ a, onRemove }: { a: ChatAttachment; onRemove?: () => void }) {
  const label = a.kind === "comment" ? `${a.comment.path.split("/").pop()}:${a.comment.startLine}` : a.kind === "file" ? a.path : a.label;
  const Icon = a.kind === "comment" ? MessageSquare : a.kind === "file" ? FileText : TerminalSquare;
  return (
    <span className="chip" title={a.kind === "comment" ? a.comment.text : a.kind === "text" ? a.text.slice(0, 400) : a.path}>
      <Icon size={11} />
      <span className="chip-text">{label}</span>
      {onRemove && <button aria-label="Remove attachment" onClick={onRemove}><X size={11} /></button>}
    </span>
  );
}

function Result({ item, onPlanApprove, showApprove, onRetry }: { item: Extract<ChatItem, { kind: "result" }>; onPlanApprove: () => void; showApprove: boolean; onRetry: () => void }) {
  if (item.cancelled) return <div className="result result-muted">Stopped · {duration(item.durationMs)}</div>;
  return (
    <div className={`result ${item.ok ? "" : "result-err"}`}>
      {!item.ok && (
        <div className="result-error">
          <p>{item.error ?? "The run failed."}</p>
          {item.retryAt ? <small>This provider's limit lifts around {new Date(item.retryAt).toLocaleTimeString()}.</small> : <Button size="sm" icon={<RotateCcw size={12} />} onClick={onRetry}>Try again</Button>}
        </div>
      )}
      <div className="result-meta">
        <ProviderMark provider={item.provider} size={6} />
        <span>{modelLabel(item.model)}</span>
        <span>{duration(item.durationMs)}</span>
        <span title={item.estimate ? "Estimated at list price. A plan's real cost per run is lower." : "Reported by the CLI."}>{money(item.costUsd)}{item.estimate ? " est." : ""}</span>
        <span>{((item.inputTokens + item.outputTokens) / 1000).toFixed(1)}k tokens</span>
      </div>
      {showApprove && (
        <div className="result-approve">
          <Button tone="accent" size="sm" icon={<Hammer size={13} />} onClick={onPlanApprove} data-testid="approve-plan">Approve and build</Button>
        </div>
      )}
    </div>
  );
}

function Transcript({ w, tab }: { w: Workspace; tab: ChatTab }) {
  const key = `${w.id}:${tab.id}`;
  const items = useStore((s) => s.chats[key]);
  const loadChat = useStore((s) => s.loadChat);
  const running = w.runningTabs.includes(tab.id);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    void loadChat(w.id, tab.id);
  }, [w.id, tab.id, loadChat]);

  useLayoutEffect(() => {
    if (pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items]);

  const groups = useMemo(() => groupItems(items ?? []), [items]);
  const lastResult = [...(items ?? [])].reverse().find((i) => i.kind === "result");
  const lastUser = [...(items ?? [])].reverse().find((i) => i.kind === "user");

  const approve = (): void => {
    void (async () => {
      await call("updateTab", { id: w.id, tabId: tab.id, mode: "build" });
      await act(() => call("send", { id: w.id, tabId: tab.id, text: "The plan is approved. Build it.", attachments: [] }));
    })();
  };
  const retry = (): void => {
    if (lastUser?.kind === "user") void act(() => call("send", { id: w.id, tabId: tab.id, text: lastUser.text, attachments: lastUser.attachments }));
  };

  if (items && items.length === 0) {
    return (
      <div className="transcript transcript-empty">
        <Empty icon={<MessageSquare size={20} />} title={w.status === "failed" ? "This workspace could not start" : "What should this workspace do?"}>
          {w.status === "failed" ? w.statusDetail : `${w.branch} is ready. Work here stays off ${w.baseRef.replace(/^origin\//, "")} until merged.`}
        </Empty>
      </div>
    );
  }
  return (
    <div className="transcript" ref={ref} onScroll={(e) => {
      const el = e.currentTarget;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }} data-testid="transcript">
      <div className="transcript-inner">
        {groups.map((g) => {
          if (g.kind === "tools") return <Tools key={g.id} items={g.items} running={running && g === groups[groups.length - 1]} />;
          if (g.kind === "user") {
            return (
              <div className="msg-user" key={g.id}>
                {g.mode === "plan" && <span className="msg-mode"><ListChecks size={11} /> Plan</span>}
                <div className="msg-user-text">{g.text}</div>
                {g.attachments.length > 0 && <div className="chips">{g.attachments.map((a, i) => <AttachmentChip key={i} a={a} />)}</div>}
              </div>
            );
          }
          if (g.kind === "assistant") return <div className="msg-agent" key={g.id}><Markdown text={g.text} /></div>;
          if (g.kind === "system") return <div className="msg-system" key={g.id}>{g.text}</div>;
          if (g.kind === "result") {
            return <Result key={g.id} item={g} onRetry={retry} onPlanApprove={approve} showApprove={g === lastResult && g.ok && tab.mode === "plan" && !running} />;
          }
          return null;
        })}
        {running && groups[groups.length - 1]?.kind !== "tools" && groups[groups.length - 1]?.kind !== "assistant" && (
          <div className="msg-thinking"><Spinner size={11} /> Working</div>
        )}
      </div>
    </div>
  );
}

function Composer({ w, tab }: { w: Workspace; tab: ChatTab }) {
  const key = `${w.id}:${tab.id}`;
  const draft = useStore((s) => s.drafts[key]);
  const setDraft = useStore((s) => s.setDraft);
  const readiness = useStore((s) => s.readiness);
  const text = draft?.text ?? "";
  const attachments = draft?.attachments ?? [];
  const running = w.runningTabs.includes(tab.id);
  const area = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    area.current?.focus();
  }, [key]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const matches = useMemo(() => {
    if (!mention || !files) return [];
    const q = mention.query.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(q)).sort((a, b) => Number(b.changed) - Number(a.changed)).slice(0, 8);
  }, [mention, files]);

  const onChange = (value: string, caret: number): void => {
    setDraft(key, { text: value });
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\w./-]*)$/.exec(before);
    if (m) {
      setMention({ query: m[2]!, start: caret - m[2]!.length - 1, index: 0 });
      if (!files) void call("files", { id: w.id }).then(setFiles).catch(() => setFiles([]));
    } else {
      setMention(null);
    }
  };

  const pick = (f: FileEntry): void => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    setDraft(key, { text: text.slice(0, mention.start) + text.slice(end), attachments: attachments.some((a) => a.kind === "file" && a.path === f.path) ? attachments : [...attachments, { kind: "file", path: f.path }] });
    setMention(null);
    area.current?.focus();
  };

  const attach = (list: File[]): void => {
    for (const file of list) {
      void act(async () => {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is over the 20 MB limit.`);
        const buf = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buf.length; i += 32768) binary += String.fromCharCode(...buf.subarray(i, i + 32768));
        const saved = await call("attachFile", { id: w.id, name: file.name || "pasted.png", base64: btoa(binary) });
        const cur = useStore.getState().drafts[key];
        setDraft(key, { attachments: [...(cur?.attachments ?? []), { kind: "file", path: saved.path }] });
      });
    }
  };

  const submit = (): void => {
    if (!text.trim() && attachments.length === 0) return;
    setDraft(key, { text: "", attachments: [] });
    void act(() => call("send", { id: w.id, tabId: tab.id, text, attachments }));
  };

  const ready = readiness.find((r) => r.provider === tab.provider);
  const models = ready?.models ?? [tab.model];
  const pendingComments = w.comments.filter((c) => !c.sentAt && !attachments.some((a) => a.kind === "comment" && a.comment.id === c.id));
  const budgetLeft = w.budgetUsd - w.spentUsd;

  return (
    <div className="composer-wrap">
      {w.queued > 0 && <div className="composer-note">{w.queued} message{w.queued === 1 ? "" : "s"} queued</div>}
      {pendingComments.length > 0 && (
        <button className="composer-note composer-note-action" onClick={() => setDraft(key, { attachments: [...attachments, ...pendingComments.map((comment) => ({ kind: "comment" as const, comment }))] })} data-testid="attach-comments">
          <MessageSquare size={12} /> Attach {pendingComments.length} review comment{pendingComments.length === 1 ? "" : "s"}
        </button>
      )}
      {budgetLeft <= 0 && (
        <button className="composer-note composer-note-warn" onClick={() => void act(() => call("setBudget", { id: w.id, budgetUsd: w.budgetUsd + 25 }), "Budget raised by $25")}>
          This workspace reached its {money(w.budgetUsd)} budget. Raise by $25
        </button>
      )}
      <div
        className={`composer ${tab.mode === "plan" ? "composer-plan" : ""} ${dragging ? "composer-drop" : ""}`}
        data-testid="composer"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (w.status !== "archived") attach([...e.dataTransfer.files]);
        }}
      >
        {mention && matches.length > 0 && (
          <div className="mention">
            {matches.map((f, i) => (
              <button key={f.path} className={`mention-item ${i === mention.index ? "mention-active" : ""}`} onMouseDown={(e) => { e.preventDefault(); pick(f); }}>
                <FileText size={12} />
                <span>{f.path}</span>
                {f.changed && <em>changed</em>}
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chips composer-chips">
            {attachments.map((a, i) => <AttachmentChip key={i} a={a} onRemove={() => setDraft(key, { attachments: attachments.filter((_, n) => n !== i) })} />)}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={w.status === "archived" ? "Restore this workspace to keep working" : running ? "Queue a follow-up" : tab.mode === "plan" ? "Describe the work. The agent plans, and changes no files" : "Ask the agent to do something. @ adds a file"}
          disabled={w.status === "archived"}
          data-testid="composer-input"
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length > 0) {
              e.preventDefault();
              attach(pasted);
            }
          }}
          onKeyDown={(e) => {
            // Enter while composing Japanese or Chinese text confirms the word. It does not send.
            if (e.nativeEvent.isComposing) return;
            if (mention && matches.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMention({ ...mention, index: (mention.index + 1) % matches.length }); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMention({ ...mention, index: (mention.index - 1 + matches.length) % matches.length }); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[mention.index]!); return; }
              if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <Select<Provider>
            up
            value={tab.provider}
            options={(["claude", "codex", "gemini"] as Provider[]).map((p) => {
              const r = readiness.find((x) => x.provider === p);
              return { value: p, label: PROVIDER_LABEL[p], icon: <ProviderMark provider={p} />, detail: r?.ready ? (r.metered ? "Metered API key" : r.account) : "Not signed in", disabled: !r?.ready };
            })}
            onChange={(provider) => {
              const m = useStore.getState().settings?.defaultModels[provider] ?? readiness.find((r) => r.provider === provider)?.defaultModel ?? "";
              void act(() => call("updateTab", { id: w.id, tabId: tab.id, provider, model: m }));
            }}
          />
          <Select<string>
            up
            value={tab.model}
            label={modelLabel(tab.model)}
            options={[...new Set([...models, tab.model])].map((m) => ({ value: m, label: modelLabel(m) }))}
            onChange={(model) => void act(() => call("updateTab", { id: w.id, tabId: tab.id, model }))}
          />
          <div className="segmented" role="radiogroup" aria-label="Mode">
            {(["build", "plan"] as Mode[]).map((m) => (
              <button key={m} role="radio" aria-checked={tab.mode === m} data-testid={`mode-${m}`} className={tab.mode === m ? "on" : ""} onClick={() => void act(() => call("updateTab", { id: w.id, tabId: tab.id, mode: m }))}>
                {m === "build" ? "Build" : "Plan"}
              </button>
            ))}
          </div>
          <span className="composer-spacer" />
          <span className="composer-budget" title={`Spent ${money(w.spentUsd)} of a ${money(w.budgetUsd)} budget`}>
            <span className="meter"><span style={{ width: `${Math.min(100, (w.spentUsd / Math.max(w.budgetUsd, 0.01)) * 100)}%` }} /></span>
            {money(w.spentUsd)}
          </span>
          {running && (
            <Button size="sm" tone="default" icon={<Square size={11} fill="currentColor" />} onClick={() => void act(() => call("stop", { id: w.id, tabId: tab.id }))} data-testid="stop">Stop</Button>
          )}
          <Button tone="accent" size="sm" aria-label="Send" title={`Send · ${mod("↵")}`} disabled={!text.trim() && attachments.length === 0} icon={<ArrowUp size={14} />} onClick={submit} data-testid="send" />
        </div>
      </div>
      <div className="composer-hint"><Kbd>↵</Kbd> send <Kbd>⇧↵</Kbd> new line <Kbd>@</Kbd> file <span>Drop or paste files and screenshots</span></div>
    </div>
  );
}

export function Chat({ w }: { w: Workspace }) {
  const activeTab = useStore((s) => s.activeTab[w.id]);
  const setActive = useStore((s) => s.setActiveTab);
  const tab = w.tabs.find((t) => t.id === activeTab) ?? w.tabs[0]!;

  const addTab = (): void => {
    void act(async () => {
      const t = await call("newTab", { id: w.id, provider: tab.provider, model: tab.model, mode: "build" });
      setActive(w.id, t.id);
    });
  };

  return (
    <div className="chat">
      <div className="tabs" role="tablist">
        {w.tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === tab.id} className={`tab ${t.id === tab.id ? "tab-on" : ""}`} onClick={() => setActive(w.id, t.id)}>
            {w.runningTabs.includes(t.id) ? <Spinner size={9} /> : <ProviderMark provider={t.provider} size={7} />}
            <span>{t.title}</span>
            {w.tabs.length > 1 && (
              <button className="tab-close" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); void act(() => call("closeTab", { id: w.id, tabId: t.id })); }}>
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button className="tab-add" aria-label="New chat tab" title={`New chat · ${mod("T")}`} onClick={addTab} data-testid="new-tab"><Plus size={13} /></button>
      </div>
      <Transcript key={tab.id} w={w} tab={tab} />
      <Composer key={`c-${tab.id}`} w={w} tab={tab} />
    </div>
  );
}

