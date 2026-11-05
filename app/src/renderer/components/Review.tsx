import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, Columns2, FileMinus2, FilePlus2, FileText, MessageSquarePlus, Rows2, Send, Trash2, Undo2,
} from "lucide-react";

import type { DiffFile, DiffLine, DiffResult, LineComment, Provider, Workspace } from "../../shared/api";
import { call } from "../api";
import { mod, PROVIDER_LABEL } from "../format";
import { highlightLine, languageOf } from "../markdown";
import { act, useStore } from "../store";
import { Button, Empty, Kbd, Menu, Select, Spinner } from "./ui";

type Selection = { path: string; side: "old" | "new"; from: number; to: number };

export function useDiff(id: string, commit: string | null, poll = true): { diff: DiffResult | null; error: string | null; reload: () => void } {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void call("diff", { id, commit }).then((d) => {
      setDiff(d);
      setError(null);
    }).catch((e: Error) => setError(e.message));
  }, [id, commit]);
  useEffect(() => {
    load();
    if (!poll) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, poll]);
  return { diff, error, reload: load };
}

function statusIcon(f: DiffFile) {
  if (f.status === "added") return <FilePlus2 size={13} className="add" />;
  if (f.status === "deleted") return <FileMinus2 size={13} className="del" />;
  return <FileText size={13} className="muted" />;
}

const CodeCell = memo(function CodeCell({ text, lang }: { text: string; lang: string | null }) {
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightLine(text, lang) || "&nbsp;" }} />;
});

function CommentCard({ c, onDelete }: { c: LineComment; onDelete: () => void }) {
  return (
    <div className={`dc ${c.sentAt ? "dc-sent" : ""}`} data-testid="line-comment">
      <div className="dc-body">{c.text}</div>
      <div className="dc-foot">
        <span>{c.sentAt ? "Sent to the agent" : "Not sent yet"}</span>
        <button aria-label="Delete comment" onClick={onDelete}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

function CommentForm({ onSave, onCancel, label }: { onSave: (t: string) => void; onCancel: () => void; label: string }) {
  const [t, setT] = useState("");
  return (
    <div className="dc-form">
      <div className="dc-label">{label}</div>
      <textarea
        autoFocus
        value={t}
        placeholder="What should change here?"
        data-testid="comment-input"
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && t.trim()) onSave(t);
        }}
      />
      <div className="dc-actions">
        <Button size="sm" tone="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" tone="accent" disabled={!t.trim()} onClick={() => onSave(t)} data-testid="comment-save">Comment <Kbd>{mod("↵")}</Kbd></Button>
      </div>
    </div>
  );
}

type RowProps = {
  l: DiffLine;
  lang: string | null;
  selected: boolean;
  onGutter: (e: React.MouseEvent, side: "old" | "new", n: number) => void;
};

const UnifiedRow = memo(function UnifiedRow({ l, lang, selected, onGutter }: RowProps) {
  const side = l.t === "del" ? "old" : "new";
  const n = (l.t === "del" ? l.o : l.n)!;
  return (
    <div className={`dl dl-${l.t} ${selected ? "dl-sel" : ""}`}>
      <span className="dl-n">{l.o ?? ""}</span>
      <span className="dl-n">{l.n ?? ""}</span>
      <button className="dl-cmt" aria-label={`Comment on line ${n}`} onClick={(e) => onGutter(e, side, n)}><MessageSquarePlus size={12} /></button>
      <span className="dl-sign">{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>
      <CodeCell text={l.s} lang={lang} />
    </div>
  );
});

function splitPairs(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const out: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.t === "ctx") {
      out.push({ left: l, right: l });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.t === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.t === "add") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

function SplitCell({ l, side, lang, sel, onGutter }: { l: DiffLine | null; side: "old" | "new"; lang: string | null; sel: Selection | null; onGutter: RowProps["onGutter"] }) {
  if (!l) return <div className="ds ds-blank" />;
  const n = (side === "old" ? l.o : l.n)!;
  const selected = !!sel && sel.side === side && n >= sel.from && n <= sel.to;
  return (
    <div className={`ds dl-${l.t} ${selected ? "dl-sel" : ""}`}>
      <span className="dl-n">{n}</span>
      <button className="dl-cmt" aria-label={`Comment on line ${n}`} onClick={(e) => onGutter(e, side, n)}><MessageSquarePlus size={12} /></button>
      <CodeCell text={l.s} lang={lang} />
    </div>
  );
}

function FileDiff({ w, f, layout, viewed, collapsed, onCollapse, onViewed, canDiscard, reload }: { w: Workspace; f: DiffFile; layout: "unified" | "split"; viewed: boolean; collapsed: boolean; onCollapse: () => void; onViewed: () => void; canDiscard: boolean; reload: () => void }) {
  const lang = useMemo(() => languageOf(f.path), [f.path]);
  const [sel, setSel] = useState<Selection | null>(null);
  const anchor = useRef<{ side: "old" | "new"; n: number } | null>(null);
  const open = useStore((s) => s.open);
  const comments = w.comments.filter((c) => c.path === f.path);
  const allLines = useMemo(() => f.hunks.flatMap((h) => h.lines), [f.hunks]);

  const onGutter = useCallback((e: React.MouseEvent, side: "old" | "new", n: number) => {
    if (e.shiftKey && anchor.current && anchor.current.side === side) {
      const a = anchor.current.n;
      setSel({ path: f.path, side, from: Math.min(a, n), to: Math.max(a, n) });
    } else {
      anchor.current = { side, n };
      setSel({ path: f.path, side, from: n, to: n });
    }
  }, [f.path]);

  const save = (text: string): void => {
    if (!sel) return;
    const excerpt = allLines.filter((l) => {
      const n = sel.side === "old" ? l.o : l.n;
      return n !== null && n >= sel.from && n <= sel.to;
    }).map((l) => l.s).join("\n");
    void act(() => call("addComment", { id: w.id, path: f.path, startLine: sel.from, endLine: sel.to, side: sel.side, text, excerpt }));
    setSel(null);
  };

  const commentsAt = (side: "old" | "new", n: number | null): LineComment[] => (n === null ? [] : comments.filter((c) => c.side === side && c.endLine === n));

  const inline = (l: DiffLine, key: string) => {
    const side = l.t === "del" ? "old" : "new";
    const n = l.t === "del" ? l.o : l.n;
    const here = commentsAt(side, n);
    const formHere = sel && sel.side === side && sel.to === n;
    if (!here.length && !formHere) return null;
    return (
      <div className="dl-extra" key={key}>
        {here.map((c) => <CommentCard key={c.id} c={c} onDelete={() => void act(() => call("deleteComment", { id: w.id, commentId: c.id }))} />)}
        {formHere && <CommentForm label={sel!.from === sel!.to ? `Line ${sel!.from}` : `Lines ${sel!.from} to ${sel!.to}`} onSave={save} onCancel={() => setSel(null)} />}
      </div>
    );
  };

  return (
    <section className={`df ${viewed ? "df-viewed" : ""}`} id={`file-${f.path}`} data-testid={`diff-${f.path}`}>
      <header className="df-head">
        <button className="df-toggle" onClick={onCollapse} aria-label={collapsed ? "Expand" : "Collapse"}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button>
        {statusIcon(f)}
        <span className="df-path" title={f.path}>
          {f.oldPath && <><span className="muted">{f.oldPath}</span> <ChevronRight size={11} /> </>}
          {f.path}
        </span>
        <span className="df-stat"><em className="add">+{f.added}</em> <em className="del">−{f.removed}</em></span>
        <span className="df-spacer" />
        {canDiscard && (
          <button className="df-btn" title="Discard this file's changes" onClick={() => open({ kind: "confirm", title: `Discard changes to ${f.path}?`, body: f.oldPath ? `The file goes back to its old name, ${f.oldPath}, and to the version this branch started from. This cannot be undone.` : "The file goes back to the version this branch started from. This cannot be undone.", action: "Discard", danger: true, run: () => void act(async () => { await call("discardFile", { id: w.id, path: f.path, oldPath: f.oldPath }); reload(); }) })}>
            <Undo2 size={13} />
          </button>
        )}
        <button className={`df-view ${viewed ? "on" : ""}`} onClick={onViewed} data-testid={`viewed-${f.path}`}>
          {viewed ? <CheckCircle2 size={13} /> : <Circle size={13} />} Viewed
        </button>
      </header>
      {!collapsed && (
        <div className="df-body">
          {f.binary && <div className="df-note">Binary file.</div>}
          {f.tooLarge && <div className="df-note">This diff is too large to show here. Open the file in an editor.</div>}
          {!f.binary && !f.tooLarge && f.hunks.length === 0 && <div className="df-note">No line changes.</div>}
          {f.hunks.map((h, hi) => (
            <div className="dh" key={hi}>
              <div className="dh-head">{h.header.replace(/^@@[^@]*@@\s?/, "") || h.header}</div>
              {layout === "unified"
                ? h.lines.map((l, li) => {
                    const side = l.t === "del" ? "old" : "new";
                    const n = (l.t === "del" ? l.o : l.n)!;
                    return (
                      <div key={li}>
                        <UnifiedRow l={l} lang={lang} selected={!!sel && sel.side === side && n >= sel.from && n <= sel.to} onGutter={onGutter} />
                        {inline(l, `x${li}`)}
                      </div>
                    );
                  })
                : splitPairs(h.lines).map((p, i) => (
                    <div key={i}>
                      <div className="dsplit">
                        <SplitCell l={p.left} side="old" lang={lang} sel={sel} onGutter={onGutter} />
                        <SplitCell l={p.right} side="new" lang={lang} sel={sel} onGutter={onGutter} />
                      </div>
                      {p.right && inline(p.right, `r${i}`)}
                      {p.left && p.left.t === "del" && inline(p.left, `l${i}`)}
                    </div>
                  ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function askReview(w: Workspace, provider: Provider, model: string): void {
  void act(async () => {
    const t = await call("newTab", { id: w.id, provider, model, mode: "plan" });
    await call("updateTab", { id: w.id, tabId: t.id, title: `${PROVIDER_LABEL[provider]} review` });
    useStore.getState().setActiveTab(w.id, t.id);
    useStore.getState().setReview(null);
    await call("send", { id: w.id, tabId: t.id, text: `Review the changes on this branch against ${w.baseRef}. Run git diff ${w.baseRef}... to see them. List real problems, most serious first, each with a file and a line. Say so plainly if the change is sound. Change no files.`, attachments: [] });
  });
}

export function Review({ w }: { w: Workspace }) {
  const review = useStore((s) => s.review);
  const setReview = useStore((s) => s.setReview);
  const readiness = useStore((s) => s.readiness);
  const setDraft = useStore((s) => s.setDraft);
  const activeTab = useStore((s) => s.activeTab[w.id]);
  const [commit, setCommit] = useState<string | null>(null);
  const [layout, setLayout] = useState<"unified" | "split">(() => {
    try {
      return localStorage.getItem("ceo.diffLayout") === "split" ? "split" : "unified";
    } catch {
      return "unified";
    }
  });
  const { diff, error, reload } = useDiff(w.id, commit);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [current, setCurrent] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  const files = diff?.files ?? [];
  const viewedCount = files.filter((f) => w.viewed[f.path] === f.hash).length;
  const pending = w.comments.filter((c) => !c.sentAt);

  const jump = useCallback((path: string) => {
    document.getElementById(`file-${path}`)?.scrollIntoView({ block: "start" });
    setCurrent(files.findIndex((f) => f.path === path));
  }, [files]);

  useEffect(() => {
    if (review?.path && diff) jump(review.path);
    // Only the first load of a path opened from elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review?.path, !!diff]);

  const toggleViewed = useCallback((f: DiffFile) => {
    const viewed = w.viewed[f.path] === f.hash;
    void act(() => call("markViewed", { id: w.id, path: f.path, hash: viewed ? null : f.hash }));
    if (!viewed) setCollapsed((c) => ({ ...c, [f.path]: true }));
    else setCollapsed((c) => ({ ...c, [f.path]: false }));
  }, [w.id, w.viewed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      if (useStore.getState().dialog || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest(".menu-wrap")) return;
      if (e.key === "Escape") setReview(null);
      if (e.key === "j" || e.key === "n") { const f = files[Math.min(current + 1, files.length - 1)]; if (f) jump(f.path); }
      if (e.key === "k" || e.key === "p") { const f = files[Math.max(current - 1, 0)]; if (f) jump(f.path); }
      if (e.key === "v") { const f = files[current]; if (f) toggleViewed(f); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files, current, jump, toggleViewed, setReview]);

  const sendComments = (): void => {
    const tab = activeTab ?? w.tabs[0]!.id;
    setDraft(`${w.id}:${tab}`, { attachments: pending.map((comment) => ({ kind: "comment" as const, comment })) });
    setReview(null);
  };

  const reviewers = readiness.filter((r) => r.ready && r.provider !== w.tabs[0]?.provider);

  return (
    <div className="review" data-testid="review">
      <header className="review-head drag">
        <div className="no-drag review-head-left">
          <Button tone="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => setReview(null)} data-testid="review-back">Chat</Button>
          <h2>Review</h2>
          <span className="muted">{files.length} file{files.length === 1 ? "" : "s"} · {viewedCount} viewed</span>
          <span className="meter meter-wide"><span style={{ width: files.length ? `${(viewedCount / files.length) * 100}%` : "0%" }} /></span>
        </div>
        <div className="no-drag review-head-right">
          {diff && diff.commits.length > 0 && (
            <Select<string>
              align="right"
              value={commit ?? "all"}
              label={commit ? diff.commits.find((c) => c.sha === commit)?.short ?? "Commit" : `All changes · ${diff.commits.length} commit${diff.commits.length === 1 ? "" : "s"}`}
              options={[{ value: "all", label: "All changes" }, ...diff.commits.map((c) => ({ value: c.sha, label: c.subject.slice(0, 60), detail: c.short }))]}
              onChange={(v) => setCommit(v === "all" ? null : v)}
            />
          )}
          <div className="segmented">
            <button className={layout === "unified" ? "on" : ""} aria-label="Unified" onClick={() => { setLayout("unified"); try { localStorage.setItem("ceo.diffLayout", "unified"); } catch { /* optional */ } }}><Rows2 size={13} /></button>
            <button className={layout === "split" ? "on" : ""} aria-label="Split" data-testid="layout-split" onClick={() => { setLayout("split"); try { localStorage.setItem("ceo.diffLayout", "split"); } catch { /* optional */ } }}><Columns2 size={13} /></button>
          </div>
          {reviewers.length > 0 && (
            <Menu
              align="right"
              trigger={(_o, t) => <Button size="sm" icon={<Bot size={13} />} onClick={t} data-testid="ask-review">Ask for a review</Button>}
              items={reviewers.map((r) => ({ label: `Ask ${PROVIDER_LABEL[r.provider]}`, detail: "Another provider reads this diff. Changes no files.", onClick: () => askReview(w, r.provider, r.defaultModel) }))}
            />
          )}
          <Button tone="accent" size="sm" icon={<Send size={13} />} disabled={pending.length === 0} onClick={sendComments} data-testid="send-comments">
            {pending.length ? `Send ${pending.length} comment${pending.length === 1 ? "" : "s"}` : "No comments"}
          </Button>
        </div>
      </header>
      <div className="review-body">
        <nav className="review-files">
          {files.map((f, i) => {
            const viewed = w.viewed[f.path] === f.hash;
            const n = w.comments.filter((c) => c.path === f.path).length;
            return (
              <button key={f.path} className={`rf ${i === current ? "rf-on" : ""} ${viewed ? "rf-viewed" : ""}`} onClick={() => jump(f.path)} title={f.path}>
                {viewed ? <CheckCircle2 size={13} className="rf-check" /> : statusIcon(f)}
                <span className="rf-path"><span className="rf-name">{f.path.split("/").pop()}</span><small>{f.path.split("/").slice(0, -1).join("/")}</small></span>
                {n > 0 && <span className="rf-count">{n}</span>}
                <span className="rf-stat"><em className="add">+{f.added}</em> <em className="del">−{f.removed}</em></span>
              </button>
            );
          })}
          <div className="review-keys"><Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>v</Kbd> viewed <Kbd>esc</Kbd> back</div>
        </nav>
        <div className="review-main" ref={scroller}>
          {error && <Empty title="Could not read the changes" icon={<FileText size={20} />}>{error}</Empty>}
          {!diff && !error && <div className="center"><Spinner size={18} /></div>}
          {diff && !error && files.length === 0 && <Empty title="No changes yet" icon={<FileText size={20} />}>This branch matches {w.baseRef}.</Empty>}
          {diff?.truncated && <div className="df-note">Showing the first {files.length} files.</div>}
          {files.map((f) => (
            <FileDiff
              key={f.path}
              w={w}
              f={f}
              layout={layout}
              viewed={w.viewed[f.path] === f.hash}
              collapsed={!!collapsed[f.path]}
              onCollapse={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))}
              onViewed={() => toggleViewed(f)}
              canDiscard={!commit && w.status !== "archived"}
              reload={reload}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
