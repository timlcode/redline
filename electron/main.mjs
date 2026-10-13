import { app, BrowserWindow, dialog } from "electron";
import updaterPkg from "electron-updater";
import { createServer } from "../server.mjs";

const { autoUpdater } = updaterPkg;

let win = null;
let port = null;

const PDF_FILTERS = [
  {
    name: "PDF and images",
    extensions: ["pdf", "jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif"],
  },
];

// Native file picker (replaces the Linux-only bin/pick-file.py GTK helper).
function pick(mode, { suggest } = {}) {
  const parent = win || undefined;
  if (mode === "open") {
    return dialog
      .showOpenDialog(parent, { properties: ["openFile"], filters: PDF_FILTERS })
      .then((r) => (r.canceled ? { canceled: true } : { path: r.filePaths[0] }));
  }
  if (mode === "files") {
    return dialog
      .showOpenDialog(parent, { properties: ["openFile", "multiSelections"], filters: PDF_FILTERS })
      .then((r) => (r.canceled ? { canceled: true } : { paths: r.filePaths }));
  }
  if (mode === "folder") {
    return dialog
      .showOpenDialog(parent, { properties: ["openDirectory", "createDirectory"] })
      .then((r) => (r.canceled ? { canceled: true } : { path: r.filePaths[0] }));
  }
  if (mode === "save" || mode === "save-any") {
    const filters = mode === "save" ? [{ name: "PDF", extensions: ["pdf"] }] : undefined;
    return dialog
      .showSaveDialog(parent, { defaultPath: suggest || "marked.pdf", filters })
      .then((r) => (r.canceled ? { canceled: true } : { path: r.filePath }));
  }
  return Promise.resolve({ canceled: true });
}

async function startServer() {
  const server = createServer({ dataDir: app.getPath("userData"), pick });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function fileArg(argv) {
  // First non-flag argv entry after the executable path is a file to open.
  for (const a of argv.slice(1)) {
    if (!a.startsWith("-")) return a;
  }
  return null;
}

function createWindow(openPath) {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    title: "Redline",
    backgroundColor: "#1a1a1a",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  let url = `http://127.0.0.1:${port}`;
  if (openPath) url += `/?open=${encodeURIComponent(openPath)}`;
  win.loadURL(url);
  win.on("closed", () => {
    win = null;
  });
}

// Auto-update from GitHub Releases via electron-updater. The repository is
// public, so a token is optional. Set REDLINE_UPDATE_TOKEN, GH_TOKEN, or
// GITHUB_TOKEN to authenticate and raise the API rate limit; without one,
// checks use the public release feed.
function setupUpdater() {
  if (!app.isPackaged) {
    console.log("[updater] dev mode — update checks disabled");
    return;
  }
  const token = process.env.REDLINE_UPDATE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (token) autoUpdater.setFeedURL({ provider: "github", owner: "timlcode", repo: "redline", token });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    dialog
      .showMessageBox({
        type: "info",
        title: "Redline update ready",
        message: `Version ${info.version} has been downloaded. Restart to install it.`,
        buttons: ["Restart now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
  autoUpdater.on("error", (e) => console.log("[updater]", e && e.message ? e.message : e));
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch((e) => console.log("[updater]", e && e.message ? e.message : e));
  check();
  setInterval(check, 4 * 60 * 60 * 1000); // every 4 hours
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win) {
      win.focus();
      const p = fileArg(argv);
      if (p) win.loadURL(`http://127.0.0.1:${port}/?open=${encodeURIComponent(p)}`);
    }
  });
  app.on("open-file", (_e, p) => {
    if (win) win.loadURL(`http://127.0.0.1:${port}/?open=${encodeURIComponent(p)}`);
  });
  app.whenReady().then(async () => {
    port = await startServer();
    createWindow(fileArg(process.argv));
    setupUpdater();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
