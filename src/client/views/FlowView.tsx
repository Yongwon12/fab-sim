import { useEffect, useRef, useState } from "react";
import type { Envelope } from "../../shared/types";
import { S } from "../strings";
import { api } from "../api";
import { act, useBoot, useLive, usePoll } from "../store";
import { fmtCompact, fmtTime } from "../format";
import { Empty, VendorTag } from "../components/ui";

interface Route {
  subscriber: string;
  pattern: string;
  label: string;
  enabled: boolean;
  delivered: number;
  errors: number;
}

interface BusInfo {
  stats: { published: number; byKind: Record<string, number>; byTopicRoot: Record<string, number> };
  routes: Route[];
  recent: Envelope[];
}

const SYSTEMS = ["EES", "FDC", "QMS", "AMS"];

/** msg/s per route from successive polls. */
function useRates(routes: Route[] | undefined) {
  const prev = useRef<{ t: number; counts: Map<string, number> } | null>(null);
  const [rates, setRates] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!routes) return;
    const t = performance.now();
    const counts = new Map(routes.map((r) => [`${r.subscriber}|${r.pattern}`, r.delivered]));
    if (prev.current) {
      const dt = (t - prev.current.t) / 1000;
      const next = new Map<string, number>();
      for (const [k, v] of counts) next.set(k, Math.max(0, (v - (prev.current.counts.get(k) ?? v)) / dt));
      setRates(next);
    }
    prev.current = { t, counts };
  }, [routes]);
  return rates;
}

export function FlowView() {
  const boot = useBoot()!;
  const live = useLive();
  const { data: bus, reload } = usePoll<BusInfo>("/api/bus?limit=150", 2000);
  const rates = useRates(bus?.routes);
  const [kind, setKind] = useState("");
  const [sel, setSel] = useState<number | null>(null);
  const toggle = async (r: Route) => {
    await act(() => api.patch("/api/bus/routes", { subscriber: r.subscriber, pattern: r.pattern, enabled: !r.enabled }), `${r.subscriber} ${r.pattern} → ${!r.enabled ? S.common.on : S.common.off}`);
    reload();
  };
  const recent = (bus?.recent ?? []).filter((m) => !kind || m.kind === kind);
  const selected = recent.find((m) => m.id === sel) ?? recent[0];
  const sysRate = (s: string) => [...rates.entries()].filter(([k]) => k.startsWith(`${s}|`)).reduce((a, [, v]) => a + v, 0);
  const byVendor = boot.vendors.map((v) => ({ v, tools: boot.equipment.filter((e) => e.vendor === v.id) }));

  return (
    <div className="page">
      <div className="page-head">
        <h2>{S.flow.title}</h2>
        <span className="muted">
          {S.flow.published}: {bus ? bus.stats.published.toLocaleString() : "—"}
        </span>
      </div>
      <div className="flow">
        <div className="flow-box">
          <h4>{S.flow.vendorFormats}</h4>
          {byVendor.map(({ v, tools }) => (
            <div key={v.id} style={{ fontSize: 12 }}>
              <VendorTag vendor={v.id} /> <b>{v.protocol}</b>
              <div className="muted">
                {tools.map((t) => {
                  const st = live.status.find((s) => s.id === t.id);
                  return (
                    <span key={t.id} style={{ marginRight: 8 }}>
                      <i className="dot" style={{ background: st ? `var(--e10-${st.e10})` : "var(--e10-NST)", marginRight: 3 }} />
                      {t.id}
                      {st?.controlState === "OFFLINE" ? " (offline)" : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="arrow" aria-hidden>
          →
        </div>
        <div className="flow-box">
          <h4>{S.flow.adapter}</h4>
          <div style={{ fontSize: 12 }}>SECS-II · XML · OPC UA → canonical</div>
          <div className="muted" style={{ fontSize: 12 }}>
            name · unit · SVID/CEID/ALID · severity
          </div>
        </div>
        <div className="arrow" aria-hidden>
          →
        </div>
        <div className="flow-box">
          <h4>{S.flow.bus}</h4>
          {bus &&
            Object.entries(bus.stats.byKind)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <div key={k} className="row" style={{ justifyContent: "space-between", fontSize: 12 }}>
                  <span className="mono">{k}</span>
                  <span className="num">{fmtCompact(v)}</span>
                </div>
              ))}
        </div>
        <div className="arrow" aria-hidden>
          →
        </div>
        <div className="flow-box">
          {SYSTEMS.map((s) => (
            <a key={s} href={`#/${s.toLowerCase()}`} className="row" style={{ justifyContent: "space-between", textDecoration: "none", color: "inherit" }}>
              <b>{s}</b>
              <span className="muted num" style={{ fontSize: 12 }}>
                {sysRate(s).toFixed(1)} msg/s
              </span>
            </a>
          ))}
          <div className="muted" style={{ fontSize: 11 }}>
            ← HOLD (FDC/QMS) · S2F41
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>{S.flow.routes}</h3>
          <span className="muted">{S.flow.hint}</span>
        </div>
        <div className="table-wrap tall">
          <table className="t">
            <thead>
              <tr>
                <th>{S.flow.enabled}</th>
                <th>{S.flow.subscriber}</th>
                <th>{S.flow.topic}</th>
                <th>{S.common.message}</th>
                <th className="num">{S.flow.delivered}</th>
                <th className="num">{S.flow.rate}</th>
              </tr>
            </thead>
            <tbody>
              {(bus?.routes ?? []).map((r) => (
                <tr key={`${r.subscriber}|${r.pattern}`}>
                  <td>
                    <input type="checkbox" checked={r.enabled} disabled={r.subscriber === "EQUIPMENT"} onChange={() => toggle(r)} aria-label={`${r.subscriber} ${r.pattern}`} />
                  </td>
                  <td>
                    <b>{r.subscriber}</b>
                  </td>
                  <td className="mono">{r.pattern}</td>
                  <td className="secondary">{r.label}</td>
                  <td className="num">{r.delivered.toLocaleString()}</td>
                  <td className="num">{(rates.get(`${r.subscriber}|${r.pattern}`) ?? 0).toFixed(1)}/s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="split">
        <div className="card">
          <div className="card-head">
            <h3>{S.flow.recent}</h3>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="kind">
              <option value="">{S.common.all}</option>
              {Object.keys(bus?.stats.byKind ?? {})
                .filter((k) => k !== "trace")
                .map((k) => (
                  <option key={k}>{k}</option>
                ))}
            </select>
          </div>
          {!recent.length ? (
            <Empty />
          ) : (
            <div className="table-wrap tall">
              <table className="t">
                <thead>
                  <tr>
                    <th>{S.common.time}</th>
                    <th>{S.flow.topic}</th>
                    <th>kind</th>
                    <th>{S.common.source}</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((m) => (
                    <tr key={m.id} className={`click ${selected?.id === m.id ? "sel" : ""}`} onClick={() => setSel(m.id)}>
                      <td className="num">{fmtTime(m.ts)}</td>
                      <td className="mono">{m.topic}</td>
                      <td>{m.kind}</td>
                      <td>{m.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h3>{selected ? `${selected.topic} #${selected.id}` : "—"}</h3>
          {selected && <pre className="frame-text">{JSON.stringify(selected, null, 2)}</pre>}
        </div>
      </div>
    </div>
  );
}
