import type { FabBridge, SaveResult } from "../shared/bridge";
import { toasts } from "./store";
import { S } from "./strings";

declare global {
  interface Window {
    fabsim?: FabBridge;
  }
}

export class ApiError extends Error {}

function bridge(): FabBridge {
  if (!window.fabsim) throw new ApiError("FAB-SIM 데스크톱 앱에서 실행하세요.");
  return window.fabsim;
}

/** API calls go to the simulator in the app's main process over IPC. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await bridge().request(method, path, body);
  if (res.status >= 400) throw new ApiError((res.data as { error?: string })?.error ?? `error ${res.status}`);
  return res.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function report(r: SaveResult) {
  if (r.saved) toasts.push(`${S.common.savedTo} ${r.path}`);
  else if (r.error) toasts.push(r.error, "error");
}

/** Save an export (CSV/JSON) produced by the simulator to a file the user picks. */
export async function saveExport(path: string) {
  try {
    report(await bridge().saveExport(path));
  } catch (err) {
    toasts.push((err as Error).message, "error");
  }
}

/** Save text to a file the user picks. */
export async function saveText(name: string, text: string) {
  try {
    report(await bridge().saveText(name, text));
  } catch (err) {
    toasts.push((err as Error).message, "error");
  }
}
