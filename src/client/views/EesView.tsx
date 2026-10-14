import { useState } from "react";
import type { E10State } from "../../shared/types";
import { S } from "../strings";
import { api, qs, saveExport } from "../api";
import { act, useBoot, usePoll } from "../store";
import { fmtDuration, fmtNum, fmtPct, fmtTime } from "../format";
import { Collapsible, ConfigForm, E10Legend, E10Pill, E10Stack, E10Timeline, E10_ORDER, Empty, Seg, Stat, StatePill, VendorTag } from "../components/ui";

interface Kpi {
  eqpId: string;
  name: string;
  type: string;
  vendor: string;
  model: string;
  state: E10State;
  since: number;
  controlState: string;
  online: boolean;
  durations: Record<E10State, number>;
  totalSec: number;
  availability: number;
  utilization: number;
  performance: number;
  quality: number;
  oee: number;
  mtbfSec: number | null;
  mttrSec: number | null;
  wph: number;
  wafers: number;
  lots: number;
  runs: number;
  aborted: number;
  alarms: number;
  activeLots: number;
}

interface Detail {
  kpis: Kpi;
  timeline: Array<{ state: E10State; start: number; end: number | null; reason: string }>;
  now: number;
}

interface EventRow {
  id: number;
  ts: number;
  eqpId: string;
  name: string;
  ceid: number;
  chamberId: string | null;
  values: Record<string, string | number>;
  extra: Record<string, string | number> | null;
}

interface LotRow {
  lotId: string;
  eqpId: string;
  recipeId: string;
  portId: number;
  waferCount: number;
  processedCount: number;
  start: number;
  end: number | null;
  result: string;
}

export function EesView() {
  const boot = useBoot()!;
  const [sel, setSel] = useState<string>(boot.equipment[0]?.id ?? "");
  const [hours, setHours] = useState(1);
  const [eventName, setEventName] = useState("");
  const [eventEqp, setEventEqp] = useState("");
  const { data: ov } = usePoll<{ overview: Kpi[]; eventCounts: Record<string, number> }>("/api/ees/overview", 2000);
  const { data: detail } = usePoll<Detail>(sel ? `/api/ees/equipment/${encodeURIComponent(sel)}?hours=${hours}` : null, 2000);
  const { data: events } = usePoll<EventRow[]>(`/api/ees/events${qs({ eqpId: eventEqp, name: eventName, limit: 300 })}`, 2500);
  const { data: lots } = usePoll<LotRow[]>(`/api/ees/lots${qs({ limit: 200 })}`, 4000);
  const { data: cfg, reload: reloadCfg } = usePoll<{ udtAlertSec: number; kpiWindowHours: number }>("/api/ees/config", 0);
  const overview = ov?.overview ?? [];
  const fleet = overview.length
    ? {
        oee: overview.reduce((s, k) => s + k.oee, 0) / overview.length,
        util: overview.reduce((s, k) => s + k.utilization, 0) / overview.length,
        wph: overview.reduce((s, k) => s + k.wph, 0),
        down: overview.filter((k) => k.state === "UDT" || k.state === "SDT").length,
      }
    : null;

  return (
    <div className="page">
      <div className="page-head">
        <h2>{S.ees.title}</h2>
        <button className="btn" onClick={() => saveExport("/api/export/events.csv")}>
          {S.ees.exportCsv}
        </button>
      </div>
      {fleet && (
        <div className="grid tiles">
          <Stat label={`Fab ${S.ees.oee}`} value={fmtPct(fleet.oee)} sub={`${overview.length} ${S.common.equipment}`} />
          <Stat label={`Fab ${S.ees.utilization}`} value={fmtPct(fleet.util)} />
          <Stat label={`Fab ${S.ees.wph}`} value={fmtNum(fleet.wph, 3)} />
          <Stat label="UDT / SDT" value={fleet.down} sub={S.e10.UDT + " · " + S.e10.SDT} />
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h3>{S.ees.overview}</h3>
          <E10Legend />
        </div>
        {!overview.length ? (
          <Empty />
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.equipment}</th>
                  <th>{S.common.state}</th>
                  <th>{S.console.control}</th>
                  <th style={{ minWidth: 160 }}>{S.ees.durations}</th>
                  <th className="num">{S.ees.availability}</th>
                  <th className="num">{S.ees.utilization}</th>
                  <th className="num">{S.ees.performance}</th>
                  <th className="num">{S.ees.quality}</th>
                  <th className="num">{S.ees.oee}</th>
                  <th className="num">{S.ees.mtbf}</th>
                  <th className="num">{S.ees.mttr}</th>
                  <th className="num">{S.ees.wph}</th>
                  <th className="num">Wafers</th>
                  <th className="num">Lots</th>
                </tr>
              </thead>
              <tbody>
                {overview.map((k) => (
                  <tr key={k.eqpId} className={`click ${sel === k.eqpId ? "sel" : ""}`} onClick={() => setSel(k.eqpId)}>
                    <td>
                      <b>{k.eqpId}</b> <VendorTag vendor={k.vendor} />
                      <div className="muted" style={{ fontSize: 11 }}>
                        {k.name}
                      </div>
                    </td>
                    <td>
                      <E10Pill state={k.state} since={k.since} now={detail?.now} />
                    </td>
                    <td>
                      <StatePill state={k.online ? k.controlState : "OFFLINE"} label={k.online ? k.controlState.replace("ONLINE_", "") : "OFFLINE"} />
                    </td>
                    <td>
                      <E10Stack durations={k.durations} />
                    </td>
                    <td className="num">{fmtPct(k.availability)}</td>
                    <td className="num">{fmtPct(k.utilization)}</td>
                    <td className="num">{fmtPct(k.performance)}</td>
                    <td className="num">{fmtPct(k.quality)}</td>
                    <td className="num">
                      <b>{fmtPct(k.oee)}</b>
                    </td>
                    <td className="num">{fmtDuration(k.mtbfSec)}</td>
                    <td className="num">{fmtDuration(k.mttrSec)}</td>
                    <td className="num">{fmtNum(k.wph, 3)}</td>
                    <td className="num">{k.wafers}</td>
                    <td className="num">{k.lots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {detail && (
        <div className="card stack">
          <div className="card-head">
            <h3>
              {S.ees.timeline} · {sel}
            </h3>
            <span className="secondary">{S.ees.hours}</span>
            <Seg
              options={[
                [0.25, "15m"],
                [1, "1h"],
                [4, "4h"],
                [12, "12h"],
              ]}
              value={hours}
              onChange={setHours}
            />
          </div>
          <E10Timeline segments={detail.timeline} from={detail.now - hours * 3_600_000} to={detail.now} />
          <div className="table-wrap" style={{ maxHeight: 220 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.state}</th>
                  <th>{S.common.time}</th>
                  <th className="num">{S.ees.since}</th>
                  <th>{S.common.message}</th>
                </tr>
              </thead>
              <tbody>
                {[...detail.timeline].reverse().map((s, i) => (
                  <tr key={i}>
                    <td>
                      <E10Pill state={s.state} />
                    </td>
                    <td className="num">
                      {fmtTime(s.start)} – {s.end ? fmtTime(s.end) : "now"}
                    </td>
                    <td className="num">{fmtDuration(((s.end ?? detail.now) - s.start) / 1000)}</td>
                    <td className="secondary">{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid tiles">
            {E10_ORDER.map((st) => (
              <Stat key={st} label={`${st} ${S.e10[st]}`} value={fmtDuration(detail.kpis.durations[st])} sub={detail.kpis.totalSec ? fmtPct(detail.kpis.durations[st] / detail.kpis.totalSec) : ""} />
            ))}
          </div>
        </div>
      )}
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h3>{S.ees.events}</h3>
            <select value={eventEqp} onChange={(e) => setEventEqp(e.target.value)} aria-label={S.common.equipment}>
              <option value="">{S.common.all}</option>
              {boot.equipment.map((e) => (
                <option key={e.id}>{e.id}</option>
              ))}
            </select>
            <select value={eventName} onChange={(e) => setEventName(e.target.value)} aria-label="event">
              <option value="">{S.common.all}</option>
              {boot.eventNames.map((n) => (
                <option key={n} value={n}>
                  {n} {ov?.eventCounts[n] ? `(${ov.eventCounts[n]})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="table-wrap tall">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.time}</th>
                  <th>{S.common.equipment}</th>
                  <th>Event</th>
                  <th>{S.events.report}</th>
                </tr>
              </thead>
              <tbody>
                {(events ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="num">{fmtTime(e.ts)}</td>
                    <td>
                      {e.eqpId}
                      {e.chamberId ? `/${e.chamberId}` : ""}
                    </td>
                    <td className="mono">{e.name}</td>
                    <td className="secondary" style={{ fontSize: 11.5 }}>
                      {Object.entries(e.values)
                        .filter(([k]) => !["EqpID", "Clock", "ChamberID"].includes(k))
                        .map(([k, v]) => `${k}=${v}`)
                        .join("  ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h3>{S.ees.lots}</h3>
          <div className="table-wrap tall">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.lot}</th>
                  <th>{S.common.equipment}</th>
                  <th>{S.common.recipe}</th>
                  <th className="num">Wafers</th>
                  <th>{S.ees.lotStart}</th>
                  <th className="num">TAT</th>
                  <th>{S.ees.result}</th>
                </tr>
              </thead>
              <tbody>
                {(lots ?? []).map((l) => (
                  <tr key={`${l.lotId}-${l.start}`}>
                    <td className="mono">{l.lotId}</td>
                    <td>{l.eqpId}</td>
                    <td>{l.recipeId}</td>
                    <td className="num">
                      {l.processedCount}/{l.waferCount}
                    </td>
                    <td className="num">{fmtTime(l.start)}</td>
                    <td className="num">{l.end ? fmtDuration((l.end - l.start) / 1000) : "—"}</td>
                    <td>
                      <StatePill state={l.result === "PROCESSING" ? "PROCESSING" : l.result === "OK" ? "OK" : "ABORTED"} label={l.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {cfg && (
        <div className="card">
          <Collapsible title={S.ees.settings}>
            <ConfigForm
              value={cfg}
              fields={[
                { key: "udtAlertSec", label: S.ees.udtAlert, type: "number" },
                { key: "kpiWindowHours", label: S.ees.kpiWindow, type: "number" },
              ]}
              onSave={async (patch) => {
                await act(() => api.put("/api/ees/config", patch), S.common.saved);
                reloadCfg();
              }}
            />
          </Collapsible>
        </div>
      )}
    </div>
  );
}
