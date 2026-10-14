import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type FabBridge } from "../shared/bridge";

// Runs sandboxed with context isolation: the page gets this narrow API and
// nothing else from Node or Electron.
const bridge: FabBridge = {
  request: (method, path, body) => ipcRenderer.invoke(IPC.request, method, path, body),
  subscribe: (topics) => ipcRenderer.send(IPC.subscribe, topics),
  onPush: (handler) => {
    const listener = (_e: IpcRendererEvent, msg: unknown) => handler(msg);
    ipcRenderer.on(IPC.push, listener);
    return () => ipcRenderer.removeListener(IPC.push, listener);
  },
  saveExport: (path) => ipcRenderer.invoke(IPC.saveExport, path),
  saveText: (name, text) => ipcRenderer.invoke(IPC.saveText, name, text),
  appVersion: process.argv.find((a) => a.startsWith("--fabsim-version="))?.split("=")[1] ?? "",
  platform: process.platform,
};

contextBridge.exposeInMainWorld("fabsim", bridge);
