import { useMemo, useState } from "react";
import type { EquipmentConfig } from "../../../shared/types";
import { S } from "../../strings";
import { fmtNum, fmtTime } from "../../format";
import { LineChart, type Band } from "../../components/LineChart";
import { Check, Empty, Seg } from "../../components/ui";
import type { EquipmentFeed, TracePoint } from "./feed";

const WINDOWS = [60, 300, 900, 1800];

/** Step regions of a trace window, for the chart bands. */
export function stepBands(points: Array<{ ts: number; ctx: TracePoint["ctx"] }>): Band[] {
  const bands: Band[] = [];
  for (const p of points) {
    const key = p.ctx ? `${p.ctx.runId}|${p.ctx.stepNo}` : "";
    const last = bands[bands.length - 1] as (Band & { key?: string }) | undefined;
    if (!p.ctx) continue;
    if (last && last.key === key) last.x1 = p.ts;
    else bands.push({ x0: p.ts, x1: p.ts, label: `${p.ctx.stepNo} ${p.ctx.stepName}`, key } as Band & { key: string });
  }
  return bands;
}

export function TracePanel({ cfg, feed, version }: { cfg: EquipmentConfig; feed: EquipmentFeed; version: number }) {
  const [chamber, setChamber] = useState(cfg.chambers[0]);
  const [params, setParams] = useState<string[]>(() => cfg.parameters.slice(0, 4).map((p) => p.key));
  const [win, setWin] = useState(300);
  const [showSp, setShowSp] = useState(true);
  const points = feed.traces.get(chamber) ?? [];
  const last = points[points.length - 1];
  const from = last ? Math.max(points[0].ts, last.ts - win * 1000) : 0;
  const interval = cfg.generation.traceIntervalMs;

  // points is a live buffer mutated in place; version marks new samples.
  const view = useMemo(() => points.filter((p) => p.ts >= from), [points, from, version]);
  const bands = useMemo(() => stepBands(view), [view]);

  const toggle = (k: string) => setParams((ps) => (ps.includes(k) ? ps.filter((x) => x !== k) : [...ps, k]));

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <span className="secondary">{S.trace.chamber}</span>
        <Seg options={cfg.chambers.map((c) => [c, c] as [string, string])} value={chamber} onChange={setChamber} />
        <span className="secondary" style={{ marginLeft: 12 }}>
          {S.trace.window}
        </span>
        <Seg options={WINDOWS.map((w) => [w, w < 60 ? S.trace.seconds(w) : S.trace.minutes(w / 60)] as [number, string])} value={win} onChange={setWin} />
        <Check label={S.trace.showSp} checked={showSp} onChange={setShowSp} />
      </div>
      <div className="row" aria-label={S.trace.params}>
        {cfg.parameters.map((p) => (
          <label key={p.key} className={`pill`} style={{ cursor: "pointer", background: params.includes(p.key) ? "var(--accent-wash)" : undefined }}>
            <input type="checkbox" checked={params.includes(p.key)} onChange={() => toggle(p.key)} style={{ margin: 0 }} />
            {p.name}
          </label>
        ))}
      </div>
      {!view.length ? (
        <Empty>{S.trace.noData}</Empty>
      ) : (
        <div className="grid cols-2">
          {params.map((key) => {
            const def = cfg.parameters.find((p) => p.key === key);
            if (!def) return null;
            const pv = view.filter((p) => key in p.values).map((p) => [p.ts, p.values[key]] as [number, number]);
            const sp = view.filter((p) => key in p.setpoints).map((p) => [p.ts, p.setpoints[key]] as [number, number]);
            return (
              <div className="card" key={key}>
                <div className="card-head">
                  <h3>
                    {def.name} <span className="muted">({def.unit})</span>
                  </h3>
                  <span className="num">
                    <b>{fmtNum(last?.values[key], 5)}</b> <span className="muted">/ SP {fmtNum(last?.setpoints[key], 5)}</span>
                  </span>
                </div>
                <LineChart
                  ariaLabel={`${def.name} trace ${chamber}`}
                  height={170}
                  bands={bands}
                  xDomain={[from, last.ts]}
                  maxGap={interval * 3.5}
                  series={[
                    { id: "pv", label: `${def.name} PV`, color: "var(--series-1)", points: pv },
                    ...(showSp ? [{ id: "sp", label: `${def.name} SP`, color: "var(--series-2)", points: sp, step: true, width: 1.5 }] : []),
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}
      {last && (
        <div className="card">
          <div className="card-head">
            <h3>
              {S.trace.current} · {chamber}
            </h3>
            <span className="muted">
              {fmtTime(last.ts)} {last.ctx ? `· ${last.ctx.runId} · step ${last.ctx.stepNo} ${last.ctx.stepName}` : ""}
            </span>
          </div>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.parameter}</th>
                  <th>key</th>
                  <th className="num">{S.trace.current}</th>
                  <th className="num">{S.trace.setpoint}</th>
                  <th>{S.common.unit}</th>
                </tr>
              </thead>
              <tbody>
                {cfg.parameters
                  .filter((p) => p.key in last.values)
                  .map((p) => (
                    <tr key={p.key}>
                      <td>{p.name}</td>
                      <td className="mono">{p.key}</td>
                      <td className="num">{fmtNum(last.values[p.key], 5)}</td>
                      <td className="num">{fmtNum(last.setpoints[p.key], 5)}</td>
                      <td>{p.unit}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
