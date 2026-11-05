/** The window process: windows, menus, dialogs and the engine's lifetime. */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, shell, utilityProcess, type UtilityProcess } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type { EngineEvent } from "../shared/api";

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** A GUI app starts without the shell's PATH, and the agent CLIs live on that PATH. */
function loginPath(): string | null {
  if (process.platform === "win32") return null;
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", "printf '__CEO_PATH__%s__' \"$PATH\""], { encoding: "utf8", timeout: 6000, stdio: ["ignore", "pipe", "ignore"] });
    return /__CEO_PATH__(.*)__/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Agents start the org server through this launcher, because the app binary is not a plain node. */
function nodeLauncher(): string {
  const dir = path.join(app.getPath("userData"), "bin");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ceo-node");
  writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

function logFile(): string {
  const dir = app.getPath("logs");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "engine.log");
}

function outPath(name: string): string {
  const p = path.join(app.getAppPath(), "out", name);
  return p.replace(`app.asar${path.sep}out${path.sep}collab`, `app.asar.unpacked${path.sep}out${path.sep}collab`);
}

function startEngine(): void {
  const found = loginPath();
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.npm-global/bin`];
  const PATH = [...new Set([...(found ?? process.env.PATH ?? "").split(":"), ...extra])].filter(Boolean).join(":");
  engine = utilityProcess.fork(outPath("engine.cjs"), [], {
    serviceName: "ceo-engine",
    stdio: "pipe",
    env: { ...process.env, PATH, CEO_NODE_BIN: nodeLauncher(), CEO_COLLAB_ENTRY: outPath("collab.cjs") } as Record<string, string>,
  });
  const log = (b: Buffer): void => {
    try {
      appendFileSync(logFile(), b);
    } catch {
      /* a full disk must not stop the app */
    }
  };
  engine.stdout?.on("data", log);
  engine.stderr?.on("data", log);
  engine.on("message", (m: { id?: number; result?: unknown; error?: string; event?: EngineEvent }) => {
    if (m.event) {
      win?.webContents.send("engine:event", m.event);
      return;
    }
    const p = pending.get(m.id!);
    if (!p) return;
    pending.delete(m.id!);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.result);
  });
  engine.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error("The engine stopped."));
    pending.clear();
    engine = null;
    if (!quitting) {
      log(Buffer.from(`${new Date().toISOString()} engine exited with ${code}; restarting\n`));
      startEngine();
      win?.webContents.reload();
    }
  });
}

let quitting = false;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    title: "CEO",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
    backgroundColor: process.platform === "darwin" ? "#00000000" : (nativeTheme.shouldUseDarkColors ? "#101214" : "#fbfbfa"),
    show: false,
    webPreferences: {
      preload: path.join(app.getAppPath(), "out", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => {
    if (!process.env.CEO_E2E_HIDDEN) win?.show();
  });
  win.loadFile(path.join(app.getAppPath(), "out", "ui", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function menu(): void {
  const send = (action: string) => () => win?.webContents.send("app:menu", action);
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "New Workspace", accelerator: "CmdOrCtrl+Shift+N", click: send("new-workspace") },
        { label: "New Race", accelerator: "CmdOrCtrl+Shift+R", click: send("new-race") },
        { label: "Plan from a Goal", accelerator: "CmdOrCtrl+Shift+G", click: send("plan") },
        { label: "New Chat Tab", accelerator: "CmdOrCtrl+T", click: send("new-tab") },
        { type: "separator" },
        { label: "Add Project", accelerator: "CmdOrCtrl+O", click: send("add-project") },
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: send("settings") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Command Palette", accelerator: "CmdOrCtrl+K", click: send("palette") },
        { label: "Review Changes", accelerator: "CmdOrCtrl+Shift+D", click: send("review") },
        { label: "Terminal", accelerator: "CmdOrCtrl+J", click: send("terminal") },
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", click: send("sidebar") },
        { label: "Toggle Inspector", accelerator: "CmdOrCtrl+Alt+B", click: send("inspector") },
        { label: "Spend", click: send("spend") },
        { label: "Insights", click: send("insights") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
      ],
    },
    {
      label: "Workspace",
      submenu: [
        { label: "Create Pull Request", accelerator: "CmdOrCtrl+Shift+P", click: send("create-pr") },
        { label: "Run", accelerator: "CmdOrCtrl+R", click: send("run") },
        { label: "Stop Agent", accelerator: "CmdOrCtrl+.", click: send("stop") },
        { label: "Archive", accelerator: "CmdOrCtrl+Shift+A", click: send("archive") },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: send("shortcuts") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function ipc(): void {
  ipcMain.handle("engine:call", (_e, method: string, params: unknown) => {
    if (!engine) throw new Error("The engine is restarting. Try again in a moment.");
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      engine!.postMessage({ id, method, params });
    });
  });
  ipcMain.handle("desktop:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], buttonLabel: "Add Project" });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle("desktop:pickSavePath", async (_e, name: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: name });
    return r.canceled ? null : r.filePath ?? null;
  });
  ipcMain.handle("desktop:openExternal", (_e, url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error("Only web links open from here.");
    return shell.openExternal(url);
  });
  ipcMain.handle("desktop:openPath", async (_e, target: string, editor?: string) => {
    if (!statSync(target).isDirectory()) throw new Error("Only folders open from here.");
    if (!editor) return shell.openPath(target);
    if (!/^[\w .+-]+$/.test(editor)) throw new Error("That editor name is not valid.");
    return new Promise<string>((resolve) => {
      const child = spawn("open", ["-a", editor, target], { stdio: "ignore" });
      child.on("close", (code) => resolve(code === 0 ? "" : `Could not open ${editor}.`));
      child.on("error", (e) => resolve(e.message));
    });
  });
  ipcMain.handle("desktop:copy", (_e, t: string) => clipboard.writeText(String(t)));
  ipcMain.handle("desktop:setBadge", (_e, n: number) => {
    app.setBadgeCount(n);
  });
  ipcMain.handle("desktop:notify", (_e, title: string, body: string, id: string | null) => {
    if (!Notification.isSupported() || win?.isFocused()) return;
    const n = new Notification({ title: String(title), body: String(body).slice(0, 240) });
    n.on("click", () => {
      win?.show();
      if (id) win?.webContents.send("app:open-workspace", id);
    });
    n.show();
  });
  ipcMain.handle("desktop:revealLogs", () => {
    shell.showItemInFolder(logFile());
  });
  ipcMain.handle("desktop:version", () => app.getVersion());
  ipcMain.handle("desktop:checkForUpdates", () => ({
    state: "unconfigured",
    detail: `CEO ${app.getVersion()}. Automatic updates start with the first signed release.`,
  }));
}

if (!app.requestSingleInstanceLock() && !process.env.CEO_E2E) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    ipc();
    menu();
    startEngine();
    createWindow();
    app.on("activate", () => {
      if (!win) createWindow();
    });
  });
  let quitAsked = false;
  app.on("before-quit", (e) => {
    if (quitAsked || !engine || !win || process.env.CEO_E2E) {
      quitting = true;
      engine?.kill();
      return;
    }
    e.preventDefault();
    const id = nextId++;
    const answer = new Promise<{ workspaces: Array<{ runningTabs: string[] }> }>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      engine!.postMessage({ id, method: "snapshot", params: undefined });
    });
    void answer.then(async (snap) => {
      const running = snap.workspaces.filter((w) => w.runningTabs.length > 0).length;
      if (running > 0) {
        const r = await dialog.showMessageBox(win!, {
          type: "warning",
          message: `${running} agent${running === 1 ? " is" : "s are"} still running`,
          detail: "Quitting stops them. Work already written stays in each worktree.",
          buttons: ["Quit", "Keep Running"],
          defaultId: 1,
          cancelId: 1,
        });
        if (r.response === 1) return;
      }
      quitAsked = true;
      app.quit();
    }).catch(() => {
      quitAsked = true;
      app.quit();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
