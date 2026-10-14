import { download } from "./format";

export class ApiError extends Error {}

/** Built with `--mode standalone`: no server, the fab runs in the page (see local.ts). */
export const STANDALONE = import.meta.env.MODE === "standalone";

// Copies through JSON so the page never holds live objects of the in-page fab,
// exactly as if they had come over the network.
const viaJson = <T>(v: unknown): T => (v === undefined ? (null as T) : JSON.parse(JSON.stringify(v)));

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (STANDALONE) {
    const { localCore } = await import("./local");
    const { status, data } = await localCore().dispatch(method, path, viaJson(body ?? {}));
    const out = viaJson<any>(data);
    if (status >= 400) throw new ApiError(out?.error ?? `${status}`);
    return out as T;
  }
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
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

/** Downloads a text export (CSV, scenario JSON) from the API. */
export async function downloadExport(path: string) {
  if (STANDALONE) {
    const { localCore } = await import("./local");
    const u = new URL(path, "http://localhost");
    const text = localCore().exportText(u.pathname, u.searchParams);
    if (!text) throw new ApiError(`No export ${u.pathname}`);
    download(text.name, text.body, text.type);
    return;
  }
  location.href = path;
}
