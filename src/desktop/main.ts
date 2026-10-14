import { app, BrowserWindow, dialog, ipcMain, Menu, session, type MenuItemConstructorOptions, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FabApp, type ExportFile, type LiveSession } from "../server/app";
import { IPC, type SaveResult } from "../shared/bridge";

// FAB-SIM desktop app. The simulator and the four fab systems run inside this
// main process; the window talks to them over IPC only. No HTTP server, no
// open port, and every network request from the window is blocked, so the
// app works the same with or without internet.

const DEV_URL = process.env.FABSIM_DEV_URL;
let fab: FabApp | null = null;
let mainWindow: BrowserWindow | null = null;
const sessions = new Map<number, LiveSession>();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void app.whenReady().then(start);
}

function start() {
  lockDown();
  fab = new FabApp({ scenarioFile: join(app.getPath("userData"), "scenario.json") });
  fab.start();

  ipcMain.handle(IPC.request, (_e, method: string, path: string, body: unknown) => fab!.dispatch(String(method), String(path), body));
  ipcMain.on(IPC.subscribe, (e, topics: unknown) => {
    if (Array.isArray(topics)) sessionFor(e.sender).subscribe(topics.map(String));
  });
  ipcMain.handle(IPC.saveExport, async (e, path: string): Promise<SaveResult> => {
    let file: ExportFile;
    try {
      file = fab!.exportFile(String(path));
    } catch (err) {
      return { saved: false, error: (err as Error).message };
    }
    return saveWithDialog(e.sender, file.name, file.body);
  });
  ipcMain.handle(IPC.saveText, (e, name: string, text: string) => saveWithDialog(e.sender, String(name), String(text)));

  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}

/** Offline by construction: refuse every web request and every permission prompt. */
function lockDown() {
  const allowed = (url: string) => (DEV_URL ? url.startsWith(DEV_URL) || url.startsWith(DEV_URL.replace(/^http/, "ws")) : false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
    callback({ cancel: !allowed(details.url) });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function sessionFor(wc: WebContents): LiveSession {
  let s = sessions.get(wc.id);
  if (!s) {
    s = fab!.openSession((msg) => {
      if (!wc.isDestroyed()) wc.send(IPC.push, msg);
    });
    sessions.set(wc.id, s);
    const id = wc.id;
    wc.once("destroyed", () => {
      sessions.get(id)?.close();
      sessions.delete(id);
    });
  }
  return s;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: "FAB-SIM",
    show: false,
    backgroundColor: "#f4f4f1",
    autoHideMenuBar: process.platform === "win32",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--fabsim-version=${app.getVersion()}`],
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  // The UI is a single page with hash routes: no navigation, no popups.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(__dirname, "..", "client", "index.html"));
}

async function saveWithDialog(wc: WebContents, name: string, body: string): Promise<SaveResult> {
  const owner = BrowserWindow.fromWebContents(wc) ?? undefined;
  const ext = name.split(".").pop() ?? "txt";
  const options = {
    defaultPath: join(app.getPath("documents"), name),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  };
  const res = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (res.canceled || !res.filePath) return { saved: false };
  try {
    await writeFile(res.filePath, body, "utf8");
    return { saved: true, path: res.filePath };
  } catch (err) {
    return { saved: false, error: (err as Error).message };
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "보기",
      submenu: [
        { role: "reload", label: "새로고침" },
        { role: "toggleDevTools", label: "개발자 도구" },
        { type: "separator" },
        { role: "resetZoom", label: "기본 크기" },
        { role: "zoomIn", label: "확대" },
        { role: "zoomOut", label: "축소" },
        { type: "separator" },
        { role: "togglefullscreen", label: "전체 화면" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  for (const s of sessions.values()) s.close();
  sessions.clear();
  fab?.stop();
  fab = null;
});
