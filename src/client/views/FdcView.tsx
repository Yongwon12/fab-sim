import { useEffect, useMemo, useRef, useState } from "react";
import type { FdcAlarmPayload } from "../../shared/types";
import { S } from "../strings";
import { api, qs } from "../api";
import { act, useBoot, usePoll } from "../store";
import { fmtNum, fmtTime } from "../format";
import { LineChart, type Band, type Series } from "../components/LineChart";
import { Check, Collapsible, ConfigForm, Empty, SevPill, Stat, StatePill } from "../components/ui";

interface Summary {
  counters: { runs: number; faults: number; interlocks: number; samples: number };
  models: { total: number; learning: number; active: number; manual: number; disabled: number };
}

interface RunRow {
  runId: string;
  eqpId: string;
  chamberId: string;
  lotId: string;
  waferIds: string[];
  recipeId: string;
  startTs: number;
  endTs: number | null;
  status: string;
  faultCount: number;
}

interface Indicator {
  stepNo: number;
  stepName: string;
  param: string;
  stat: string;
  value: number;
  center: number | null;
  lcl: number | null;
  ucl: number | null;
  violated: boolean;
  modelKey: string;
}

interface RunDetail extends RunRow {
  steps: Array<{ stepNo: number; stepName: string; startTs: number; endTs: number }>;
  samples: Array<{ ts: number; stepNo: number; values: Record<string, number>; setpoints: Record<string, number> }>;
  indicators: Indicator[];
  faults: Array<FdcAlarmPayload & { id: number; ts: number }>;
}

interface Trend {
  key: string;
  eqpId: string;
  chamberId: string;
  recipeId: string;
  stepNo: number;
  stepName: string;
  param: string;
  stat: string;
  state: string;
  source: string;
  center: number;
  lcl: number;
  ucl: number;
  history: Array<{ runId: string; ts: number; value: number; violated: boolean }>;
}

type FdcConfig = Record<string, number | boolean | string>;

const runCache = new Map<string, RunDetail>();

async function loadRun(runId: string): Promise<RunDetail | null> {
  const cached = runCache.get(runId);
  if (cached) return cached;
  try {
    const r = await api.get<RunDetail>(`/api/fdc/runs/${encodeURIComponent(runId)}`);
    if (r.endTs !== null) runCache.set(runId, r);
    if (runCache.size > 80) runCache.delete(runCache.keys().next().value!);
    return r;
  } catch {
    return null;
  }
}

export function FdcView() {
  const boot = useBoot()!;
  const [eqpId, setEqpId] = useState("");
  const [chamberId, setChamberId] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [param, setParam] = useState("");
  const [compare, setCompare] = useState(true);
  const [violOnly, setViolOnly] = useState(false);
  const [modelKey, setModelKey] = useState<string | null>(null);
  const { data: summary } = usePoll<Summary>("/api/fdc/summary", 2000);
  const { data: runs } = usePoll<RunRow[]>(`/api/fdc/runs${qs({ eqpId, chamberId, limit: 150 })}`, 2000);
  const { data: faults } = usePoll<Array<FdcAlarmPayload & { id: number; ts: number }>>(`/api/fdc/faults${qs({ eqpId, limit: 200 })}`, 2500);
  const { data: cfg, reload: reloadCfg } = usePoll<FdcConfig>("/api/fdc/config", 0);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [prev, setPrev] = useState<RunDetail[]>([]);
  const chambers = boot.equipment.find((e) => e.id === eqpId)?.chambers ?? [];

  useEffect(() => {
    if (!runId && runs?.length) setRunId((runs.find((r) => r.endTs !== null) ?? runs[0]).runId);
  }, [runs, runId]);

  const runsRef = useRef(runs);
  runsRef.current = runs;
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let ended = false;
    const refresh = async () => {
      const r = await loadRun(runId);
      if (!alive || !r) return;
      ended = r.endTs !== null;
      setRun(r);
      const keys = Object.keys(r.samples[0]?.values ?? {});
      setParam((p) => (p && keys.includes(p) ? p : (keys[0] ?? "")));
      const same = (runsRef.current ?? [])
        .filter((x) => x.eqpId === r.eqpId && x.chamberId === r.chamberId && x.recipeId === r.recipeId && x.runId !== r.runId && x.startTs < r.startTs && x.endTs !== null)
        .slice(0, 5);
      const others = (await Promise.all(same.map((x) => loadRun(x.runId)))).filter(Boolean) as RunDetail[];
      if (alive) setPrev(others);
    };
    void refresh();
    const t = setInterval(() => {
      if (!ended) void refresh();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId]);

  const { data: trend, reload: reloadTrend } = usePoll<Trend>(modelKey ? `/api/fdc/trend?key=${encodeURIComponent(modelKey)}` : null, 3000);

  const chart = useMemo(() => {
    if (!run || !param) return null;
    const t0 = run.startTs;
    const series: Series[] = [];
    if (compare) {
      prev.forEach((p, i) =>
        series.push({ id: `prev-${i}`, label: p.runId, color: "var(--text-muted)", faint: true, width: 1.5, points: p.samples.map((s) => [(s.ts - p.startTs) / 1000, s.values[param]] as [number, number]) }),
      );
    }
    series.push({ id: "sp", label: "SP", color: "var(--series-2)", step: true, width: 1.5, points: run.samples.map((s) => [(s.ts - t0) / 1000, s.setpoints[param]] as [number, number]) });
    series.push({ id: "pv", label: `${param} ${run.runId}`, color: "var(--series-1)", points: run.samples.map((s) => [(s.ts - t0) / 1000, s.values[param]] as [number, number]) });
    const bands: Band[] = run.steps.map((st) => ({ x0: (st.startTs - t0) / 1000, x1: (st.endTs - t0) / 1000, label: `${st.stepNo} ${st.stepName}` }));
    return { series, bands };
  }, [run, prev, param, compare]);

  const indicators = (run?.indicators ?? []).filter((i) => (!violOnly || i.violated) && (!param || i.param === param || violOnly));

  return (
    <div className="page">
      <div className="page-head">
        <h2>{S.fdc.title}</h2>
        <select value={eqpId} onChange={(e) => (setEqpId(e.target.value), setChamberId(""), setRunId(null))} aria-label={S.common.equipment}>
          <option value="">{S.common.all}</option>
          {boot.equipment.map((e) => (
            <option key={e.id}>{e.id}</option>
          ))}
        </select>
        <select value={chamberId} onChange={(e) => (setChamberId(e.target.value), setRunId(null))} disabled={!eqpId} aria-label={S.common.chamber}>
          <option value="">{S.common.all}</option>
          {chambers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      {summary && (
        <div className="grid tiles">
          <Stat label={S.fdc.runs} value={summary.counters.runs} sub={`${summary.counters.samples.toLocaleString()} samples`} />
          <Stat label={S.fdc.faults} value={summary.counters.faults} />
          <Stat label={S.fdc.interlocks} value={summary.counters.interlocks} />
          <Stat label={`${S.fdc.models} ${S.fdc.active}`} value={summary.models.active} sub={`${S.fdc.learning} ${summary.models.learning} · manual ${summary.models.manual}`} />
        </div>
      )}
      <div className="split">
        <div className="card">
          <h3>{S.fdc.runList}</h3>
          {!runs?.length ? (
            <Empty />
          ) : (
            <div className="table-wrap tall">
              <table className="t">
                <thead>
                  <tr>
                    <th>{S.common.time}</th>
                    <th>Run</th>
                    <th>{S.common.recipe}</th>
                    <th>{S.common.wafer}</th>
                    <th>{S.fdc.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.runId} className={`click ${runId === r.runId ? "sel" : ""}`} onClick={() => (setRunId(r.runId), setModelKey(null))}>
                      <td className="num">{fmtTime(r.startTs)}</td>
                      <td className="mono">{r.runId}</td>
                      <td>{r.recipeId}</td>
                      <td>{r.waferIds.length > 1 ? `${r.waferIds.length} wafers` : r.waferIds[0]}</td>
                      <td>
                        <StatePill state={r.status} label={r.faultCount ? `${r.status} ${r.faultCount}` : r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card stack">
          {!run ? (
            <Empty>{S.fdc.selectRun}</Empty>
          ) : (
            <>
              <div className="card-head">
                <h3>
                  {S.fdc.trace} · <span className="mono">{run.runId}</span>
                </h3>
                <select value={param} onChange={(e) => setParam(e.target.value)} aria-label={S.common.parameter}>
                  {Object.keys(run.samples[0]?.values ?? {}).map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
                <Check label={`${S.fdc.compare} (${prev.length})`} checked={compare} onChange={setCompare} />
                <a className="btn small" href={`/api/fdc/runs/${encodeURIComponent(run.runId)}/csv`}>
                  {S.fdc.csv}
                </a>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {run.eqpId}/{run.chamberId} · {run.recipeId} · {S.common.lot} {run.lotId} · {run.waferIds.join(", ")} · <StatePill state={run.status} />
              </div>
              {chart && <LineChart ariaLabel={`${param} run trace`} height={240} series={chart.series} bands={chart.bands} xType="number" xFormat={(x) => `${x.toFixed(0)}s`} />}
              {run.faults.length > 0 && (
                <div className="stack" style={{ gap: 4 }}>
                  {run.faults.map((f) => (
                    <div key={f.id} className="row" style={{ fontSize: 12 }}>
                      <SevPill sev={f.severity} />
                      <b>{f.faultClass}</b>
                      <span>{f.message}</span>
                      {f.interlock && <StatePill state="HOLD" label={S.fdc.interlock} />}
                    </div>
                  ))}
                </div>
              )}
              <div className="card-head" style={{ marginTop: 6, marginBottom: 0 }}>
                <h3>{S.fdc.indicators}</h3>
                <Check label={S.fdc.violationsOnly} checked={violOnly} onChange={setViolOnly} />
              </div>
              <div className="table-wrap" style={{ maxHeight: 280 }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>{S.common.step}</th>
                      <th>{S.common.parameter}</th>
                      <th>{S.fdc.indicator}</th>
                      <th className="num">{S.common.value}</th>
                      <th className="num">LCL</th>
                      <th className="num">UCL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {indicators.map((i) => (
                      <tr key={i.modelKey} className={`click ${i.violated ? "bad" : ""} ${modelKey === i.modelKey ? "sel" : ""}`} onClick={() => setModelKey(i.modelKey)}>
                        <td>
                          {i.stepNo} {i.stepName}
                        </td>
                        <td className="mono">{i.param}</td>
                        <td>{i.stat}</td>
                        <td className="num">
                          {fmtNum(i.value, 5)}
                          {i.violated ? " ⚠" : ""}
                        </td>
                        <td className="num">{i.lcl === null ? S.fdc.learning : fmtNum(i.lcl, 5)}</td>
                        <td className="num">{i.ucl === null ? "" : fmtNum(i.ucl, 5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
      {modelKey && trend && <TrendCard trend={trend} onChanged={reloadTrend} />}
      <div className="card">
        <h3>{S.fdc.faultList}</h3>
        {!faults?.length ? (
          <Empty />
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.time}</th>
                  <th>{S.common.equipment}</th>
                  <th>{S.common.severity}</th>
                  <th>{S.fdc.class}</th>
                  <th>{S.common.parameter}</th>
                  <th>{S.common.step}</th>
                  <th className="num">{S.common.value}</th>
                  <th className="num">{S.fdc.limits}</th>
                  <th>Run</th>
                  <th>{S.fdc.interlock}</th>
                </tr>
              </thead>
              <tbody>
                {faults.map((f) => (
                  <tr key={f.id} className="click" onClick={() => (setEqpId(""), setRunId(f.runId))}>
                    <td className="num">{fmtTime(f.ts)}</td>
                    <td>
                      {f.eqpId}/{f.chamberId}
                    </td>
                    <td>
                      <SevPill sev={f.severity} />
                    </td>
                    <td>{f.faultClass}</td>
                    <td className="mono">
                      {f.param} <span className="muted">{f.indicator}</span>
                    </td>
                    <td>
                      {f.stepNo} {f.stepName}
                    </td>
                    <td className="num">{fmtNum(f.value, 5)}</td>
                    <td className="num">
                      {fmtNum(f.lcl, 4)} ~ {fmtNum(f.ucl, 4)}
                    </td>
                    <td className="mono">{f.runId}</td>
                    <td>{f.interlock ? "HOLD" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {cfg && (
        <div className="card">
          <Collapsible title={S.fdc.settings}>
            <ConfigForm
              value={cfg}
              fields={[
                { key: "baselineRuns", label: S.fdc.cfg.baselineRuns, type: "number" },
                { key: "sigmaK", label: S.fdc.cfg.sigmaK, type: "number", step: 0.5 },
                { key: "minWidthFactor", label: S.fdc.cfg.minWidthFactor, type: "number", step: 0.1 },
                { key: "trimSec", label: S.fdc.cfg.trimSec, type: "number" },
                { key: "settleFactor", label: S.fdc.cfg.settleFactor, type: "number", step: 0.1 },
                { key: "settleMaxSec", label: S.fdc.cfg.settleMaxSec, type: "number" },
                { key: "minSamples", label: S.fdc.cfg.minSamples, type: "number" },
                { key: "realtime", label: S.fdc.cfg.realtime, type: "bool" },
                { key: "realtimeFactor", label: S.fdc.cfg.realtimeFactor, type: "number", step: 0.5 },
                { key: "interlock", label: S.fdc.cfg.interlock, type: "select", options: ["OFF", "CRITICAL", "ALL"] },
                { key: "criticalFactor", label: S.fdc.cfg.criticalFactor, type: "number", step: 0.5 },
                { key: "driftRuns", label: S.fdc.cfg.driftRuns, type: "number" },
              ]}
              onSave={async (patch) => {
                await act(() => api.put("/api/fdc/config", patch), S.common.saved);
                reloadCfg();
              }}
            />
          </Collapsible>
        </div>
      )}
    </div>
  );
}

function TrendCard({ trend, onChanged }: { trend: Trend; onChanged: () => void }) {
  const [lcl, setLcl] = useState(String(trend.lcl));
  const [ucl, setUcl] = useState(String(trend.ucl));
  useEffect(() => {
    setLcl(Number.isFinite(trend.lcl) ? String(Number(trend.lcl.toPrecision(6))) : "");
    setUcl(Number.isFinite(trend.ucl) ? String(Number(trend.ucl.toPrecision(6))) : "");
  }, [trend.key, trend.lcl, trend.ucl]);
  const pts = trend.history.map((h) => [h.ts, h.value] as [number, number]);
  const active = trend.state === "ACTIVE";
  const describe = (x: number) => {
    const h = trend.history.find((p) => p.ts === x);
    return h ? `${h.runId}${h.violated ? " ⚠" : ""}` : null;
  };
  const save = async () => {
    await act(() => api.patch("/api/fdc/models", { key: trend.key, lcl: Number(lcl), ucl: Number(ucl) }), S.common.saved);
    onChanged();
  };
  const relearn = async (scope: Record<string, string>) => {
    await act(() => api.post<{ models: number }>("/api/fdc/relearn", scope), (r: { models: number }) => `${S.fdc.relearn}: ${r.models}`);
    onChanged();
  };
  return (
    <div className="card stack">
      <div className="card-head">
        <h3>
          {S.fdc.trend} · {trend.eqpId}/{trend.chamberId} · {trend.recipeId} · step {trend.stepNo} {trend.stepName} · <span className="mono">{trend.param}</span> {trend.stat}
        </h3>
        <StatePill state={trend.state === "ACTIVE" ? "OK" : "LEARNING"} label={`${trend.state} · ${trend.source}`} />
      </div>
      <LineChart
        ariaLabel={`${trend.param} ${trend.stat} trend`}
        height={220}
        series={[{ id: "v", label: `${trend.param} ${trend.stat}`, color: "var(--series-1)", points: pts, dots: true }]}
        markers={trend.history.filter((h) => h.violated).map((h) => ({ x: h.ts, y: h.value, color: "var(--critical)" }))}
        refLines={
          active
            ? [
                { y: trend.ucl, label: "UCL", color: "var(--critical)" },
                { y: trend.center, label: "CL", color: "var(--text-muted)", dash: false },
                { y: trend.lcl, label: "LCL", color: "var(--critical)" },
              ]
            : []
        }
        describe={describe}
      />
      <div className="row">
        <label className="field">
          LCL
          <input type="number" value={lcl} onChange={(e) => setLcl(e.target.value)} />
        </label>
        <label className="field">
          UCL
          <input type="number" value={ucl} onChange={(e) => setUcl(e.target.value)} />
        </label>
        <button className="btn primary" onClick={save} style={{ alignSelf: "flex-end" }}>
          {S.fdc.editLimits}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ alignSelf: "flex-end" }} onClick={() => relearn({ eqpId: trend.eqpId, chamberId: trend.chamberId, recipeId: trend.recipeId })}>
          {S.fdc.relearn} ({trend.chamberId} · {trend.recipeId})
        </button>
        <button className="btn" style={{ alignSelf: "flex-end" }} onClick={() => relearn({ eqpId: trend.eqpId })}>
          {S.fdc.relearn} ({trend.eqpId})
        </button>
      </div>
    </div>
  );
}
