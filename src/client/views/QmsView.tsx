import { useEffect, useState } from "react";
import { S } from "../strings";
import { api, qs } from "../api";
import { act, useBoot, usePoll } from "../store";
import { fmtNum, fmtTime } from "../format";
import { LineChart, type RefLine, type Series } from "../components/LineChart";
import { Collapsible, ConfigForm, Empty, Seg, SERIES, Stat, StatePill } from "../components/ui";

interface ChartRow {
  key: string;
  eqpId: string;
  item: string;
  name: string;
  unit: string;
  target: number;
  usl: number | null;
  lsl: number | null;
  cl: number | null;
  ucl: number | null;
  lcl: number | null;
  limitSource: string;
  points: number;
  ooc: number;
  oos: number;
  last: { value: number; ts: number; violations: string[] } | null;
  mean: number | null;
  std: number | null;
  cp: number | null;
  cpk: number | null;
}

interface Point {
  ts: number;
  value: number;
  lotId: string;
  waferId: string;
  chamberId: string;
  runId: string;
  recipeId: string;
  fdcStatus: string | null;
  violations: string[];
}

interface ChartDetail extends Omit<ChartRow, "points" | "last"> {
  specSource: string;
  sigma: number | null;
  n: number;
  points: Point[];
}

interface Lot {
  lotId: string;
  eqpId: string;
  recipeId: string;
  status: string;
  measured: number;
  oos: number;
  ooc: number;
  reason: string;
  lastTs: number;
  dispositionBy: string | null;
}

interface Summary {
  charts: number;
  points: number;
  ooc: number;
  oos: number;
  lots: { total: number; hold: number; passed: number; released: number; scrapped: number; rework: number };
}

interface QmsConfig {
  baselinePoints: number;
  holdOnOos: boolean;
  inhibitAfterOosLots: number;
  rules: Record<string, boolean>;
}

export function QmsView() {
  const boot = useBoot()!;
  const [eqpId, setEqpId] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [lotFilter, setLotFilter] = useState("HOLD");
  const { data: summary } = usePoll<Summary>("/api/qms/summary", 2500);
  const { data: charts } = usePoll<ChartRow[]>(`/api/qms/charts${qs({ eqpId })}`, 2500);
  const { data: chart, reload: reloadChart } = usePoll<ChartDetail>(key ? `/api/qms/chart?key=${encodeURIComponent(key)}&limit=200` : null, 2500);
  const { data: lots, reload: reloadLots } = usePoll<Lot[]>(`/api/qms/lots${qs({ status: lotFilter === "ALL" ? "" : lotFilter, limit: 200 })}`, 3000);
  const { data: cfg, reload: reloadCfg } = usePoll<QmsConfig>("/api/qms/config", 0);

  useEffect(() => {
    if (!key && charts?.length) setKey(charts[0].key);
  }, [charts, key]);

  const dispose = async (lotId: string, status: string) => {
    await act(() => api.post(`/api/qms/lots/${encodeURIComponent(lotId)}/disposition`, { status, by: "QE" }), `${lotId} → ${status}`);
    reloadLots();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>{S.qms.title}</h2>
        <select value={eqpId} onChange={(e) => (setEqpId(e.target.value), setKey(null))} aria-label={S.common.equipment}>
          <option value="">{S.common.all}</option>
          {boot.equipment.map((e) => (
            <option key={e.id}>{e.id}</option>
          ))}
        </select>
      </div>
      {summary && (
        <div className="grid tiles">
          <Stat label={S.qms.charts} value={summary.charts} sub={`${summary.points} ${S.qms.points}`} />
          <Stat label={S.qms.ooc} value={summary.ooc} />
          <Stat label={S.qms.oos} value={summary.oos} />
          <Stat label={`${S.common.lot} ${S.qms.hold}`} value={summary.lots.hold} sub={`${summary.lots.total} lots · ${S.qms.release} ${summary.lots.released} · ${S.qms.scrap} ${summary.lots.scrapped}`} />
        </div>
      )}
      <div className="split">
        <div className="card">
          <h3>{S.qms.charts}</h3>
          {!charts?.length ? (
            <Empty />
          ) : (
            <div className="table-wrap tall">
              <table className="t">
                <thead>
                  <tr>
                    <th>{S.common.equipment}</th>
                    <th>Item</th>
                    <th className="num">n</th>
                    <th className="num">{S.qms.mean}</th>
                    <th className="num">{S.qms.cpk}</th>
                    <th className="num">{S.qms.ooc}</th>
                    <th className="num">{S.qms.oos}</th>
                    <th>{S.qms.last}</th>
                  </tr>
                </thead>
                <tbody>
                  {charts.map((c) => (
                    <tr key={c.key} className={`click ${key === c.key ? "sel" : ""} ${c.last?.violations.includes("OOS") ? "bad" : ""}`} onClick={() => setKey(c.key)}>
                      <td>{c.eqpId}</td>
                      <td>
                        {c.name} <span className="muted">{c.unit}</span>
                      </td>
                      <td className="num">{c.points}</td>
                      <td className="num">{fmtNum(c.mean, 5)}</td>
                      <td className="num" style={{ color: c.cpk !== null && c.cpk < 1.33 ? "var(--critical-ink)" : undefined, fontWeight: 600 }}>
                        {fmtNum(c.cpk, 3)}
                      </td>
                      <td className="num">{c.ooc}</td>
                      <td className="num">{c.oos}</td>
                      <td style={{ fontSize: 11.5 }}>
                        {c.last ? fmtNum(c.last.value, 5) : "—"} <span className="muted">{c.last?.violations.join(" ")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card stack">{!chart ? <Empty>{S.qms.selectChart}</Empty> : <SpcCard chart={chart} onChanged={reloadChart} />}</div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>{S.qms.lots}</h3>
          <Seg
            options={[
              ["HOLD", S.qms.hold],
              ["PASSED", "PASSED"],
              ["RELEASED", S.qms.release],
              ["SCRAPPED", S.qms.scrap],
              ["REWORK", S.qms.rework],
              ["ALL", S.common.all],
            ]}
            value={lotFilter}
            onChange={setLotFilter}
          />
        </div>
        {!lots?.length ? (
          <Empty />
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.lot}</th>
                  <th>{S.common.equipment}</th>
                  <th>{S.common.recipe}</th>
                  <th>{S.common.state}</th>
                  <th className="num">measured</th>
                  <th className="num">{S.qms.oos}</th>
                  <th className="num">{S.qms.ooc}</th>
                  <th>{S.common.message}</th>
                  <th>{S.common.time}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => (
                  <tr key={l.lotId}>
                    <td className="mono">{l.lotId}</td>
                    <td>{l.eqpId}</td>
                    <td>{l.recipeId}</td>
                    <td>
                      <StatePill state={l.status} />
                    </td>
                    <td className="num">{l.measured}</td>
                    <td className="num">{l.oos}</td>
                    <td className="num">{l.ooc}</td>
                    <td className="secondary">
                      {l.reason}
                      {l.dispositionBy ? ` · ${l.dispositionBy}` : ""}
                    </td>
                    <td className="num">{fmtTime(l.lastTs)}</td>
                    <td>
                      {l.status === "HOLD" && (
                        <div className="row" style={{ gap: 4 }}>
                          <button className="btn small" onClick={() => dispose(l.lotId, "RELEASED")}>
                            {S.qms.release}
                          </button>
                          <button className="btn small" onClick={() => dispose(l.lotId, "REWORK")}>
                            {S.qms.rework}
                          </button>
                          <button className="btn small danger" onClick={() => dispose(l.lotId, "SCRAPPED")}>
                            {S.qms.scrap}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {cfg && (
        <div className="card">
          <Collapsible title={S.qms.settings}>
            <div className="stack">
              <ConfigForm
                value={{ ...cfg, ...Object.fromEntries(Object.entries(cfg.rules).map(([k, v]) => [`rule_${k}`, v])) }}
                fields={[
                  { key: "baselinePoints", label: S.qms.baseline, type: "number" },
                  { key: "inhibitAfterOosLots", label: S.qms.inhibit, type: "number" },
                  { key: "holdOnOos", label: S.qms.holdOnOos, type: "bool" },
                  ...Object.keys(cfg.rules).map((r) => ({ key: `rule_${r}` as never, label: `${r} ${boot.spcRules[r] ?? ""}`, type: "bool" as const })),
                ]}
                onSave={async (patch) => {
                  const p = patch as Record<string, unknown>;
                  const rules = Object.fromEntries(Object.keys(cfg.rules).map((r) => [r, Boolean(p[`rule_${r}`])]));
                  await act(() => api.put("/api/qms/config", { baselinePoints: p.baselinePoints, inhibitAfterOosLots: p.inhibitAfterOosLots, holdOnOos: p.holdOnOos, rules }), S.common.saved);
                  reloadCfg();
                }}
              />
            </div>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

function SpcCard({ chart, onChanged }: { chart: ChartDetail; onChanged: () => void }) {
  const boot = useBoot()!;
  const chambers = boot.equipment.find((e) => e.id === chart.eqpId)?.chambers ?? [...new Set(chart.points.map((p) => p.chamberId))];
  const [spec, setSpec] = useState({ target: "", usl: "", lsl: "" });
  useEffect(() => {
    setSpec({ target: String(chart.target), usl: chart.usl === null ? "" : String(chart.usl), lsl: chart.lsl === null ? "" : String(chart.lsl) });
  }, [chart.key, chart.target, chart.usl, chart.lsl]);

  const series: Series[] = [
    { id: "all", label: "all", color: "var(--text-muted)", width: 1, quiet: true, points: chart.points.map((p) => [p.ts, p.value]) },
    ...chambers.map((c, i) => ({
      id: c,
      label: c,
      color: SERIES[i % SERIES.length],
      dots: true,
      noLine: true,
      points: chart.points.filter((p) => p.chamberId === c).map((p) => [p.ts, p.value] as [number, number]),
    })),
  ];
  const refLines: RefLine[] = [];
  if (chart.usl !== null) refLines.push({ y: chart.usl, label: "USL", color: "var(--critical)" });
  if (chart.lsl !== null) refLines.push({ y: chart.lsl, label: "LSL", color: "var(--critical)" });
  if (chart.ucl !== null) refLines.push({ y: chart.ucl, label: "UCL", color: "var(--serious)" });
  if (chart.lcl !== null) refLines.push({ y: chart.lcl, label: "LCL", color: "var(--serious)" });
  if (chart.cl !== null) refLines.push({ y: chart.cl, label: "CL", color: "var(--text-muted)", dash: false });
  refLines.push({ y: chart.target, label: "Target", color: "var(--good)", dash: false });
  const describe = (x: number) => {
    const p = chart.points.find((q) => q.ts === x);
    return p ? `${p.waferId} · ${p.chamberId} · FDC ${p.fdcStatus ?? "—"}${p.violations.length ? " · " + p.violations.join(",") : ""}` : null;
  };
  const num = (v: string) => (v === "" ? null : Number(v));
  const saveSpec = async () => {
    await act(() => api.patch("/api/qms/chart", { key: chart.key, target: Number(spec.target), usl: num(spec.usl), lsl: num(spec.lsl) }), S.common.saved);
    onChanged();
  };
  const relearn = async () => {
    await act(() => api.patch("/api/qms/chart", { key: chart.key, relearn: true }), S.qms.relearn);
    onChanged();
  };

  return (
    <>
      <div className="card-head">
        <h3>
          {chart.eqpId} · {chart.name} <span className="muted">({chart.unit || "—"})</span>
        </h3>
        <span className="secondary num">
          Cp {fmtNum(chart.cp, 3)} · Cpk <b>{fmtNum(chart.cpk, 3)}</b> · σ {fmtNum(chart.std, 3)} · {chart.limitSource}
        </span>
      </div>
      <LineChart
        ariaLabel={`${chart.name} SPC`}
        height={260}
        series={series}
        refLines={refLines}
        markers={chart.points.filter((p) => p.violations.length).map((p) => ({ x: p.ts, y: p.value, color: "var(--critical)" }))}
        describe={describe}
      />
      <div className="row">
        <label className="field">
          {S.qms.target}
          <input type="number" value={spec.target} onChange={(e) => setSpec({ ...spec, target: e.target.value })} />
        </label>
        <label className="field">
          LSL
          <input type="number" value={spec.lsl} onChange={(e) => setSpec({ ...spec, lsl: e.target.value })} />
        </label>
        <label className="field">
          USL
          <input type="number" value={spec.usl} onChange={(e) => setSpec({ ...spec, usl: e.target.value })} />
        </label>
        <button className="btn primary" style={{ alignSelf: "flex-end" }} onClick={saveSpec}>
          {S.qms.spec} {S.common.save}
        </button>
        <button className="btn" style={{ alignSelf: "flex-end" }} onClick={relearn}>
          {S.qms.relearn}
        </button>
      </div>
      <div className="table-wrap" style={{ maxHeight: 240 }}>
        <table className="t">
          <thead>
            <tr>
              <th>{S.common.time}</th>
              <th>{S.common.wafer}</th>
              <th>{S.common.chamber}</th>
              <th className="num">{S.common.value}</th>
              <th>{S.qms.rules}</th>
              <th>{S.qms.fdcVerdict}</th>
            </tr>
          </thead>
          <tbody>
            {[...chart.points].reverse().slice(0, 60).map((p) => (
              <tr key={`${p.waferId}-${p.ts}`} className={p.violations.includes("OOS") ? "bad" : ""}>
                <td className="num">{fmtTime(p.ts)}</td>
                <td className="mono">{p.waferId}</td>
                <td>{p.chamberId}</td>
                <td className="num">{fmtNum(p.value, 5)}</td>
                <td>{p.violations.join(", ")}</td>
                <td>{p.fdcStatus ? <StatePill state={p.fdcStatus} /> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
