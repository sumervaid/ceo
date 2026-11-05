// Renders resources/icon.svg to a 1024 px PNG with a transparent corner. Run through tools/make-icon.sh.
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(path.join(__dirname, "../resources/icon.svg"), "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  writeFileSync(process.argv[2], image.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
