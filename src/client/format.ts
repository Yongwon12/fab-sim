const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Simulated timestamps are shown in the viewer's local time. */
export function fmtTime(ts: number | null | undefined, withDate = false): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}` : t;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 10000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 100) return v.toFixed(Math.max(0, digits - 2));
  if (abs >= 1) return v.toFixed(Math.max(0, digits - 1));
  return v.toPrecision(Math.max(1, digits));
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtCompact(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(0)}K`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
