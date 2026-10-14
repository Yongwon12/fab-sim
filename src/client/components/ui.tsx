import { useState, type ReactNode } from "react";
import type { E10State, Severity } from "../../shared/types";
import { S } from "../strings";
import { fmtDuration, fmtTime } from "../format";
import { STANDALONE, downloadExport } from "../api";

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"];

export const E10_ORDER: E10State[] = ["PRD", "SBY", "ENG", "SDT", "UDT", "NST"];

export function E10Pill({ state, since, now }: { state: E10State; since?: number; now?: number }) {
  return (
    <span className="pill e10" title={S.e10[state]}>
      <i className="dot" style={{ background: `var(--e10-${state})` }} />
      {state}
      <span className="secondary" style={{ fontFamily: "var(--font)", fontWeight: 500 }}>
        {S.e10[state]}
        {since && now ? ` · ${fmtDuration((now - since) / 1000)}` : ""}
      </span>
    </span>
  );
}

export function SevPill({ sev }: { sev: Severity }) {
  return (
    <span className={`pill sev-${sev}`}>
      <i className="dot" />
      {sev}
    </span>
  );
}

const TONE: Record<string, string> = {
  OK: "var(--good)",
  PASSED: "var(--good)",
  RELEASED: "var(--good)",
  ONLINE_REMOTE: "var(--good)",
  PROCESSING: "var(--accent)",
  EXECUTING: "var(--accent)",
  RUNNING: "var(--accent)",
  IN_PROGRESS: "var(--accent)",
  LEARNING: "var(--e10-NST)",
  IDLE: "var(--e10-NST)",
  WARN: "var(--warning)",
  ONLINE_LOCAL: "var(--warning)",
  PAUSED: "var(--warning)",
  HOLD: "var(--serious)",
  REWORK: "var(--serious)",
  PM: "var(--e10-SDT)",
  FAULT: "var(--critical)",
  DOWN: "var(--critical)",
  ABORTED: "var(--critical)",
  SCRAPPED: "var(--critical)",
  OFFLINE: "var(--critical)",
  ACTIVE: "var(--critical)",
  ACKED: "var(--warning)",
  CLEARED: "var(--serious)",
  CLOSED: "var(--e10-NST)",
};

export function StatePill({ state, label }: { state: string; label?: string }) {
  return (
    <span className="pill">
      <i className="dot" style={{ background: TONE[state] ?? "var(--e10-NST)" }} />
      {label ?? state}
    </span>
  );
}

export function VendorTag({ vendor }: { vendor: string }) {
  return <span className="vendor">{vendor}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, ReactNode]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string | number>({ options, value, onChange }: { options: Array<[T, ReactNode]>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([k, label]) => (
        <button key={String(k)} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  return <div className="empty">{children ?? S.common.empty}</div>;
}

export function NumField({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="field">
      {label}
      <input type="number" value={Number.isFinite(value) ? value : ""} step={step ?? "any"} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function Check({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** E10 state timeline: one bar per segment, title gives the details (table view lives next to it). */
export function E10Timeline({ segments, from, to }: { segments: Array<{ state: E10State; start: number; end: number | null; reason: string }>; from: number; to: number }) {
  const span = Math.max(1, to - from);
  return (
    <div>
      <div className="timeline" role="img" aria-label={S.ees.timeline}>
        {segments.map((s, i) => {
          const a = Math.max(from, s.start);
          const b = Math.min(to, s.end ?? to);
          if (b <= a) return null;
          return (
            <div
              key={i}
              className="seg-bar"
              style={{ left: `${((a - from) / span) * 100}%`, width: `${((b - a) / span) * 100}%`, background: `var(--e10-${s.state})` }}
              title={`${s.state} ${S.e10[s.state]} · ${fmtTime(s.start)}–${s.end ? fmtTime(s.end) : "now"} · ${s.reason}`}
            />
          );
        })}
      </div>
      <div className="row muted" style={{ justifyContent: "space-between", fontSize: 11, marginTop: 2 }}>
        <span>{fmtTime(from)}</span>
        <span>{fmtTime(to)}</span>
      </div>
    </div>
  );
}

export function E10Legend() {
  return (
    <div className="legend">
      {E10_ORDER.map((s) => (
        <span key={s}>
          <i className="swatch" style={{ background: `var(--e10-${s})` }} />
          {s} {S.e10[s]}
        </span>
      ))}
    </div>
  );
}

export function E10Stack({ durations }: { durations: Record<E10State, number> }) {
  const total = E10_ORDER.reduce((s, k) => s + (durations[k] ?? 0), 0) || 1;
  return (
    <div className="stackbar" role="img" aria-label={S.ees.durations}>
      {E10_ORDER.filter((k) => durations[k] > 0).map((k) => (
        <div key={k} style={{ flex: durations[k] / total, background: `var(--e10-${k})` }} title={`${k} ${fmtDuration(durations[k])} (${((durations[k] / total) * 100).toFixed(1)}%)`} />
      ))}
    </div>
  );
}

export function Confirm({ text, onYes, children, className }: { text: string; onYes: () => void; children: ReactNode; className?: string }) {
  return (
    <button className={className ?? "btn"} onClick={() => window.confirm(text) && onYes()}>
      {children}
    </button>
  );
}

export function Collapsible({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{title}</summary>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </details>
  );
}

export interface FieldSpec<T> {
  key: keyof T & string;
  label: string;
  type: "number" | "bool" | "select";
  options?: string[];
  step?: number;
}

/** Settings form with a local draft and one save. */
export function ConfigForm<T extends object>({ value, fields, onSave }: { value: T; fields: Array<FieldSpec<T>>; onSave: (patch: Partial<T>) => Promise<unknown> | void }) {
  const [draft, setDraft] = useState<T>(value);
  const [dirty, setDirty] = useState(false);
  const set = (k: keyof T, v: unknown) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };
  const rec = draft as Record<string, unknown>;
  return (
    <div className="stack">
      <div className="form-grid">
        {fields.map((f) =>
          f.type === "bool" ? (
            <div key={f.key} className="stack" style={{ justifyContent: "flex-end" }}>
              <Check label={f.label} checked={Boolean(rec[f.key])} onChange={(v) => set(f.key, v)} />
            </div>
          ) : f.type === "select" ? (
            <label key={f.key} className="field">
              {f.label}
              <select value={String(rec[f.key])} onChange={(e) => set(f.key, e.target.value)}>
                {f.options!.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          ) : (
            <NumField key={f.key} label={f.label} value={Number(rec[f.key])} step={f.step} onChange={(v) => set(f.key, v)} />
          ),
        )}
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={!dirty}
          onClick={async () => {
            await onSave(draft);
            setDirty(false);
          }}
        >
          {S.common.save}
        </button>
        <button
          className="btn"
          disabled={!dirty}
          onClick={() => {
            setDraft(value);
            setDirty(false);
          }}
        >
          {S.common.cancel}
        </button>
      </div>
    </div>
  );
}

/** A link to a text export; in the standalone build the file is made in the page. */
export function ExportLink({ path, className = "btn", children }: { path: string; className?: string; children: ReactNode }) {
  if (!STANDALONE) {
    return (
      <a className={className} href={path}>
        {children}
      </a>
    );
  }
  return (
    <a
      className={className}
      href={path}
      onClick={(e) => {
        e.preventDefault();
        void downloadExport(path);
      }}
    >
      {children}
    </a>
  );
}
