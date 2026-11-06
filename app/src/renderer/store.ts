import { create } from "zustand";

import type { ChatAttachment, ChatItem, EngineEvent, LicenseState, Org, Readiness, Settings, Snapshot, Workspace } from "../shared/api";
import { bridge, call, desktop } from "./api";

export type InspectorTab = "changes" | "files" | "checks" | "terminal" | "run" | "record";
export type OrgTab = "chief" | "team" | "tasks" | "live" | "map" | "approvals" | "docket" | "mission" | "integrations";
export type Page = { kind: "home" } | { kind: "workspace"; id: string } | { kind: "spend" } | { kind: "insights" } | { kind: "history" } | { kind: "race"; id: string } | { kind: "org"; projectId: string; tab: OrgTab; agent?: string | null };
export type Dialog =
  | { kind: "new-workspace"; projectId?: string }
  | { kind: "race"; projectId?: string }
  | { kind: "plan"; projectId?: string }
  | { kind: "create-pr"; id: string }
  | { kind: "project"; projectId: string }
  | { kind: "settings"; tab?: "general" | "providers" | "license" }
  | { kind: "upgrade"; reason?: string }
  | { kind: "shortcuts" }
  | { kind: "palette" }
  | { kind: "confirm"; title: string; body: string; action: string; danger?: boolean; run: () => void }
  | { kind: "hire"; projectId: string; preset?: { name?: string; role?: string; level?: import("../shared/api").Level; isolated?: boolean; budgetUsd?: number } }
  | { kind: "edit-agent"; projectId: string; name: string }
  | { kind: "delegate"; projectId: string; agent?: string }
  | { kind: "task"; projectId: string; assignee?: string }
  | { kind: "company"; projectId: string }
  | { kind: "suggest"; projectId: string }
  | { kind: "broadcast"; projectId: string };
export type Toast = { id: number; text: string; level: "info" | "error" | "ok"; action?: { label: string; run: () => void } };
export type Draft = { text: string; attachments: ChatAttachment[] };

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* a preference that does not stick is not worth an error */
  }
}

type State = {
  ready: boolean;
  snapshot: Snapshot;
  settings: Settings | null;
  license: LicenseState | null;
  readiness: Readiness[];
  page: Page;
  dialog: Dialog | null;
  toasts: Toast[];
  chats: Record<string, ChatItem[]>;
  drafts: Record<string, Draft>;
  activeTab: Record<string, string>;
  inspector: InspectorTab;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  review: { path: string | null } | null;
  inspectorWidth: number;
  sidebarWidth: number;
  collapsed: Record<string, boolean>;
  orgs: Record<string, Org>;
  loadOrg(projectId: string): Promise<void>;
  setPage(p: Page): void;
  open(d: Dialog | null): void;
  toast(text: string, level?: Toast["level"], action?: Toast["action"]): void;
  dismiss(id: number): void;
  setDraft(key: string, d: Partial<Draft>): void;
  setActiveTab(ws: string, tab: string): void;
  setInspector(t: InspectorTab): void;
  toggleInspector(): void;
  toggleSidebar(): void;
  setReview(r: { path: string | null } | null): void;
  setWidths(p: { inspectorWidth?: number; sidebarWidth?: number }): void;
  toggleCollapsed(id: string): void;
  loadChat(ws: string, tab: string): Promise<void>;
  refreshReadiness(refresh?: boolean): Promise<void>;
  saveSettings(p: Partial<Settings>): Promise<void>;
};

let toastId = 1;

export const useStore = create<State>((set, get) => ({
  ready: false,
  snapshot: { projects: [], workspaces: [], races: [], org: {} },
  settings: null,
  license: null,
  readiness: [],
  page: load<Page>("ceo.page", { kind: "home" }),
  dialog: null,
  toasts: [],
  chats: {},
  drafts: {},
  activeTab: load("ceo.activeTab", {}),
  inspector: load<InspectorTab>("ceo.inspector", "changes"),
  inspectorOpen: load("ceo.inspectorOpen", true),
  sidebarOpen: load("ceo.sidebarOpen", true),
  review: null,
  inspectorWidth: load("ceo.inspectorWidth", 400),
  sidebarWidth: load("ceo.sidebarWidth", 268),
  collapsed: load("ceo.collapsed", {}),
  orgs: {},
  loadOrg: async (projectId) => {
    try {
      const org = await call("org", { projectId });
      set((s) => ({ orgs: { ...s.orgs, [projectId]: org } }));
    } catch {
      /* the project closed */
    }
  },
  setPage: (page) => {
    keep("ceo.page", page);
    set({ page, review: null });
    if (page.kind === "workspace") void call("markRead", { id: page.id });
  },
  open: (dialog) => set({ dialog }),
  toast: (text, level = "info", action) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, level, action }] }));
    setTimeout(() => get().dismiss(id), level === "error" ? 7000 : 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setDraft: (key, d) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? { text: "", attachments: [] }), ...d } } })),
  setActiveTab: (ws, tab) => {
    const activeTab = { ...get().activeTab, [ws]: tab };
    keep("ceo.activeTab", activeTab);
    set({ activeTab });
  },
  setInspector: (inspector) => {
    keep("ceo.inspector", inspector);
    keep("ceo.inspectorOpen", true);
    set({ inspector, inspectorOpen: true });
  },
  toggleInspector: () => {
    keep("ceo.inspectorOpen", !get().inspectorOpen);
    set({ inspectorOpen: !get().inspectorOpen });
  },
  toggleSidebar: () => {
    keep("ceo.sidebarOpen", !get().sidebarOpen);
    set({ sidebarOpen: !get().sidebarOpen });
  },
  setReview: (review) => set({ review }),
  setWidths: (p) => {
    if (p.inspectorWidth) keep("ceo.inspectorWidth", p.inspectorWidth);
    if (p.sidebarWidth) keep("ceo.sidebarWidth", p.sidebarWidth);
    set(p);
  },
  toggleCollapsed: (id) => {
    const collapsed = { ...get().collapsed, [id]: !get().collapsed[id] };
    keep("ceo.collapsed", collapsed);
    set({ collapsed });
  },
  loadChat: async (ws, tab) => {
    const items = await call("chatHistory", { id: ws, tabId: tab });
    set((s) => ({ chats: { ...s.chats, [`${ws}:${tab}`]: items } }));
  },
  refreshReadiness: async (refresh = false) => {
    set({ readiness: await call("readiness", { refresh }) });
  },
  saveSettings: async (p) => {
    set({ settings: await call("saveSettings", p) });
  },
}));

/** A soft two-note chime. No audio file, nothing to load. */
function chime(kind: "done" | "failed" | "info"): void {
  try {
    const ctx = new AudioContext();
    const notes = kind === "failed" ? [392, 330] : [587, 880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = "sine";
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
    setTimeout(() => void ctx.close(), 900);
  } catch {
    /* no audio device */
  }
}

const orgTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Org changes arrive in bursts. One read per burst. */
function reloadOrg(projectId: string): void {
  if (orgTimers.has(projectId)) return;
  orgTimers.set(projectId, setTimeout(() => {
    orgTimers.delete(projectId);
    void useStore.getState().loadOrg(projectId);
  }, 120));
}

function applyEvent(e: EngineEvent): void {
  const s = useStore.getState();
  switch (e.type) {
    case "snapshot": {
      useStore.setState({ snapshot: e.snapshot });
      const unread = e.snapshot.workspaces.filter((w) => w.activity === "unread" && w.status !== "archived").length;
      void desktop.setBadge(unread);
      const page = useStore.getState().page;
      if (page.kind === "workspace" && document.hasFocus()) {
        const open = e.snapshot.workspaces.find((w) => w.id === page.id);
        if (open?.activity === "unread") void call("markRead", { id: open.id });
      }
      break;
    }
    case "chat": {
      const key = `${e.workspaceId}:${e.tabId}`;
      if (!s.chats[key]) break;
      useStore.setState({ chats: { ...s.chats, [key]: [...s.chats[key], e.item] } });
      break;
    }
    case "chat-delta": {
      const key = `${e.workspaceId}:${e.tabId}`;
      const list = s.chats[key];
      if (!list) break;
      useStore.setState({
        chats: { ...s.chats, [key]: list.map((i) => (i.id === e.itemId && i.kind === "assistant" ? { ...i, text: i.text + e.text } : i)) },
      });
      break;
    }
    case "notify": {
      if (e.sound) chime(e.level);
      const settings = s.settings;
      if (settings?.notifications !== false) void desktop.notify(e.title, e.body, e.workspaceId);
      const open = e.workspaceId;
      // The workspace on screen already shows its result.
      if (e.level !== "failed" && document.hasFocus() && s.page.kind === "workspace" && s.page.id === open) break;
      s.toast(e.title, e.level === "failed" ? "error" : e.level === "done" ? "ok" : "info", open ? { label: "Open", run: () => useStore.getState().setPage({ kind: "workspace", id: open }) } : undefined);
      break;
    }
    case "license":
      useStore.setState({ license: e.license });
      break;
    case "org":
      if (s.orgs[e.projectId]) reloadOrg(e.projectId);
      break;
    case "org-run": {
      const o = s.orgs[e.run.projectId];
      if (!o) break;
      const runs = o.runs.some((r) => r.key === e.run.key) ? o.runs.map((r) => (r.key === e.run.key ? e.run : r)) : [e.run, ...o.runs];
      useStore.setState({ orgs: { ...s.orgs, [o.projectId]: { ...o, runs } } });
      break;
    }
    case "org-line": {
      const o = s.orgs[e.projectId];
      if (!o) break;
      const runs = o.runs.map((r) => {
        if (r.key !== e.key) return r;
        const lines = r.lines.slice();
        const last = lines[lines.length - 1];
        if (e.line.kind === "text" && last?.kind === "text") lines[lines.length - 1] = { kind: "text", text: last.text + e.line.text };
        else lines.push(e.line);
        return { ...r, lines: lines.length > 400 ? lines.slice(-400) : lines };
      });
      useStore.setState({ orgs: { ...s.orgs, [o.projectId]: { ...o, runs } } });
      break;
    }
    default:
      break;
  }
}

export async function boot(): Promise<void> {
  bridge.on(applyEvent);
  bridge.onOpen((id) => useStore.getState().setPage({ kind: "workspace", id }));
  const [snapshot, settings, license, readiness] = await Promise.all([call("snapshot"), call("settings"), call("license"), call("readiness", {})]);
  useStore.setState({ snapshot, settings, license, readiness, ready: true });
  const page = useStore.getState().page;
  if (page.kind === "workspace" && !snapshot.workspaces.some((w) => w.id === page.id)) useStore.getState().setPage({ kind: "home" });
  if (page.kind === "race" && !snapshot.races.some((r) => r.id === page.id)) useStore.getState().setPage({ kind: "home" });
  if (page.kind === "org" && !snapshot.projects.some((p) => p.id === page.projectId)) useStore.getState().setPage({ kind: "home" });
}

export function useWorkspace(id: string | null): Workspace | undefined {
  return useStore((s) => s.snapshot.workspaces.find((w) => w.id === id));
}

/** Run an action, sending a failure to a toast. A license refusal opens the upgrade sheet instead. */
export async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) useStore.getState().toast(ok, "ok");
    return r;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/part of Pro|free plan/.test(message)) useStore.getState().open({ kind: "upgrade", reason: message });
    else useStore.getState().toast(message, "error");
    return undefined;
  }
}
