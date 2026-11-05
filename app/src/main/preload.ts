import { contextBridge, ipcRenderer } from "electron";
import type { Bridge, EngineEvent } from "../shared/api";

const bridge: Bridge = {
  call: (method, params) => ipcRenderer.invoke("engine:call", method, params),
  on: (cb) => {
    const fn = (_: unknown, e: EngineEvent): void => cb(e);
    ipcRenderer.on("engine:event", fn);
    return () => ipcRenderer.off("engine:event", fn);
  },
  onOpen: (cb) => {
    const fn = (_: unknown, id: string): void => cb(id);
    ipcRenderer.on("app:open-workspace", fn);
    return () => ipcRenderer.off("app:open-workspace", fn);
  },
  onMenu: (cb) => {
    const fn = (_: unknown, a: string): void => cb(a);
    ipcRenderer.on("app:menu", fn);
    return () => ipcRenderer.off("app:menu", fn);
  },
  platform: process.platform,
  desktop: {
    pickFolder: () => ipcRenderer.invoke("desktop:pickFolder"),
    pickSavePath: (name) => ipcRenderer.invoke("desktop:pickSavePath", name),
    openExternal: (url) => ipcRenderer.invoke("desktop:openExternal", url),
    openPath: (p, app) => ipcRenderer.invoke("desktop:openPath", p, app),
    copy: (t) => ipcRenderer.invoke("desktop:copy", t),
    setBadge: (n) => ipcRenderer.invoke("desktop:setBadge", n),
    notify: (t, b, id) => ipcRenderer.invoke("desktop:notify", t, b, id),
    version: () => ipcRenderer.invoke("desktop:version"),
    checkForUpdates: () => ipcRenderer.invoke("desktop:checkForUpdates"),
    revealLogs: () => ipcRenderer.invoke("desktop:revealLogs"),
  },
};
contextBridge.exposeInMainWorld("ceo", bridge);
