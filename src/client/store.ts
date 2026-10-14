import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CommandAction, Envelope, EquipmentConfig, EquipmentStatus, FaultInjection, SimStatus, VendorId, EquipmentType, EventName } from "../shared/types";
import { topicMatches } from "../shared/topics";
import { api } from "./api";

// Client state: the bootstrap data (configs, catalogs), the live WebSocket
// feed (sim status, equipment status, streamed messages) and small hooks.

export interface VendorInfo {
  id: VendorId;
  name: string;
  protocol: string;
  description: string;
}

export interface TemplateInfo {
  type: EquipmentType;
  label: string;
  area: string;
  processMode: "single" | "batch";
  defaultChambers: string[];
  recipes: string[];
}

export interface Bootstrap {
  sim: SimStatus;
  vendors: VendorInfo[];
  templates: TemplateInfo[];
  eventNames: EventName[];
  commandActions: CommandAction[];
  spcRules: Record<string, string>;
  equipment: EquipmentConfig[];
  status: EquipmentStatus[];
  faults: FaultInjection[];
}

interface LiveState {
  connected: boolean;
  sim: SimStatus | null;
  status: EquipmentStatus[];
  alarms: { active: number; critical: number; unacked: number };
}

type Listener = () => void;

class Store {
  boot: Bootstrap | null = null;
  bootError: string | null = null;
  live: LiveState = { connected: false, sim: null, status: [], alarms: { active: 0, critical: 0, unacked: 0 } };
  private listeners = new Set<Listener>();
  private subs = new Map<number, { patterns: string[]; fn: (m: Envelope[]) => void }>();
  private subSeq = 0;
  private connected = false;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  async loadBootstrap() {
    try {
      this.boot = await api.get<Bootstrap>("/api/bootstrap");
      this.bootError = null;
      if (!this.live.sim) this.live = { ...this.live, sim: this.boot.sim, status: this.boot.status };
    } catch (err) {
      this.bootError = (err as Error).message;
    }
    this.emit();
  }

  connect() {
    if (this.connected) return;
    const bridge = window.fabsim;
    if (!bridge) {
      this.bootError = "FAB-SIM 데스크톱 앱에서 실행하세요 (브라우저에서는 동작하지 않습니다).";
      this.emit();
      return;
    }
    this.connected = true;
    bridge.onPush((raw) => {
      const msg = raw as { type: string; sim?: SimStatus; status?: EquipmentStatus[]; alarms?: LiveState["alarms"]; messages?: Envelope[] };
      if (msg.type === "status") {
        this.live = { connected: true, sim: msg.sim!, status: msg.status!, alarms: msg.alarms! };
        this.emit();
      } else if (msg.type === "messages") {
        for (const sub of this.subs.values()) {
          const mine = msg.messages!.filter((m) => sub.patterns.some((p) => topicMatches(p, m.topic)));
          if (mine.length) sub.fn(mine);
        }
      }
    });
    this.sendSubscriptions();
  }

  private sendSubscriptions() {
    if (!this.connected) return;
    const topics = [...new Set([...this.subs.values()].flatMap((s) => s.patterns))];
    window.fabsim?.subscribe(topics);
  }

  listen(patterns: string[], fn: (m: Envelope[]) => void): () => void {
    const id = ++this.subSeq;
    this.subs.set(id, { patterns, fn });
    this.sendSubscriptions();
    return () => {
      this.subs.delete(id);
      this.sendSubscriptions();
    };
  }
}

export const store = new Store();

export function useStore<T>(select: (s: Store) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store));
}

export function useBoot() {
  return useStore((s) => s.boot);
}

export function useLive() {
  return useStore((s) => s.live);
}

export function useStatus(eqpId: string | undefined): EquipmentStatus | undefined {
  return useStore((s) => s.live.status.find((x) => x.id === eqpId));
}

/** Streamed bus/local messages for the given topic patterns. */
export function useTopics(patterns: string[], fn: (m: Envelope[]) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const key = patterns.join("|");
  useEffect(() => {
    if (!key) return;
    return store.listen(key.split("|"), (m) => ref.current(m));
  }, [key]);
}

/** Poll a REST endpoint; keeps the previous data while refetching. */
export function usePoll<T>(path: string | null, intervalMs: number) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) {
      setData(undefined);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (document.hidden) {
        timer = setTimeout(run, intervalMs);
        return;
      }
      try {
        const d = await api.get<T>(path);
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
      if (alive && intervalMs > 0) timer = setTimeout(run, intervalMs);
    };
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [path, intervalMs, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

// ------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error";
}

class Toasts {
  items: Toast[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  push(text: string, tone: Toast["tone"] = "ok") {
    const t = { id: ++this.seq, text, tone };
    this.items = [...this.items.slice(-3), t];
    this.listeners.forEach((l) => l());
    setTimeout(() => {
      this.items = this.items.filter((x) => x.id !== t.id);
      this.listeners.forEach((l) => l());
    }, tone === "error" ? 6000 : 3000);
  }
}

export const toasts = new Toasts();

export function useToasts() {
  return useSyncExternalStore(toasts.subscribe, () => toasts.items);
}

/** Run an API action, toast the outcome, return the result (or undefined on error). */
export async function act<T>(fn: () => Promise<T>, okText?: string | ((r: T) => string)): Promise<T | undefined> {
  try {
    const r = await fn();
    const text = typeof okText === "function" ? okText(r) : okText;
    const res = r as unknown as { ok?: boolean; message?: string };
    if (res && typeof res === "object" && "ok" in res && "message" in res) toasts.push(res.message ?? "", res.ok ? "ok" : "error");
    else if (text) toasts.push(text);
    return r;
  } catch (err) {
    toasts.push((err as Error).message, "error");
    return undefined;
  }
}

// ------------------------------------------------------------- routing

export function useHashRoute(): string[] {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export function go(...parts: string[]) {
  location.hash = "/" + parts.map(encodeURIComponent).join("/");
}
