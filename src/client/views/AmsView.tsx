import { useState } from "react";
import type { Severity } from "../../shared/types";
import { S } from "../strings";
import { api, qs } from "../api";
import { act, useBoot, usePoll } from "../store";
import { fmtDuration, fmtTime } from "../format";
import { Check, Collapsible, Empty, Seg, SevPill, Stat, StatePill } from "../components/ui";

interface Alarm {
  id: number;
  source: string;
  eqpId: string;
  chamberId: string | null;
  code: string;
  text: string;
  severity: Severity;
  state: "ACTIVE" | "ACKED" | "CLEARED" | "CLOSED";
  latching: boolean;
  raisedAt: number;
  lastAt: number;
  count: number;
  ackedAt: number | null;
  ackedBy: string | null;
  escalation: number;
  shelved: boolean;
}

interface Stats {
  total: number;
  active: number;
  acked: number;
  clearedUnacked: number;
  criticalOpen: number;
  notifications: number;
  mttaSec: number | null;
  bySource: Record<string, number>;
  bySeverity: Record<string, number>;
  topCodes: Array<{ code: string; source: string; count: number }>;
}

interface Notification {
  id: number;
  ts: number;
  alarmId: number;
  eqpId: string;
  severity: Severity;
  reason: string;
  rule: string;
  group: string;
  recipients: string[];
  channels: string[];
  message: string;
}

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  minSeverity: Severity;
  sources: string[];
  eqpPattern: string;
  group: string;
  channels: string[];
}

interface AmsConfig {
  rules: Rule[];
  groups: Array<{ id: string; name: string; members: string[] }>;
  escalation: Array<{ afterSec: number; group: string }>;
  escalationMinSeverity: Severity;
  floodThreshold: number;
  floodWindowSec: number;
}

const SOURCES = ["", "EQP", "FDC", "QMS", "EES", "AMS"];

export function AmsView() {
  const boot = useBoot()!;
  const [source, setSource] = useState("");
  const [eqpId, setEqpId] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const { data: alarms, reload } = usePoll<Alarm[]>(`/api/ams/alarms${qs({ source, eqpId, open: openOnly ? 1 : "", limit: 300 })}`, 2000);
  const { data: stats } = usePoll<Stats>("/api/ams/stats", 2000);
  const { data: notes } = usePoll<Notification[]>("/api/ams/notifications?limit=150", 3000);
  const { data: cfg, reload: reloadCfg } = usePoll<AmsConfig>("/api/ams/config", 0);
  const { data: sim } = usePoll<{ simTime: number }>("/api/sim", 2000);
  const now = sim?.simTime ?? Date.now();

  const ack = async (id: number) => {
    await act(() => api.post(`/api/ams/alarms/${id}/ack`, { by: "operator" }));
    reload();
  };
  const closeAlarm = async (id: number) => {
    await act(() => api.post(`/api/ams/alarms/${id}/close`, { by: "operator" }));
    reload();
  };
  const ackAll = async () => {
    await act(() => api.post<{ acked: number }>("/api/ams/ack-all", { eqpId: eqpId || undefined, source: source || undefined, by: "operator" }), (r: { acked: number }) => `${S.ams.ackAll}: ${r.acked}`);
    reload();
  };
  const shelve = async (a: Alarm) => {
    await act(() => api.post("/api/ams/shelve", { eqpId: a.eqpId, code: a.code, minutes: 30, by: "operator" }), `${a.code} ${S.ams.shelve}`);
    reload();
  };
  const toggleRule = async (id: string, enabled: boolean) => {
    if (!cfg) return;
    await act(() => api.put("/api/ams/config", { rules: cfg.rules.map((r) => (r.id === id ? { ...r, enabled } : r)) }), S.common.saved);
    reloadCfg();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>{S.ams.title}</h2>
      </div>
      {stats && (
        <div className="grid tiles">
          <Stat label={S.ams.active} value={stats.active} sub={`${S.ams.states.ACKED} ${stats.acked}`} />
          <Stat label={S.ams.critical} value={stats.criticalOpen} />
          <Stat label={S.ams.clearedUnacked} value={stats.clearedUnacked} />
          <Stat label={S.ams.mtta} value={fmtDuration(stats.mttaSec)} />
          <Stat label={S.ams.notifications} value={stats.notifications} />
          <Stat
            label={S.common.source}
            value={stats.total}
            sub={Object.entries(stats.bySource)
              .map(([k, v]) => `${k} ${v}`)
              .join(" · ")}
          />
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h3>{S.ams.alarms}</h3>
          <Seg options={SOURCES.map((s) => [s, s || S.common.all] as [string, string])} value={source} onChange={setSource} />
          <select value={eqpId} onChange={(e) => setEqpId(e.target.value)} aria-label={S.common.equipment}>
            <option value="">{S.common.all}</option>
            {boot.equipment.map((e) => (
              <option key={e.id}>{e.id}</option>
            ))}
          </select>
          <Check label={S.ams.openOnly} checked={openOnly} onChange={setOpenOnly} />
          <button className="btn" onClick={ackAll}>
            {S.ams.ackAll}
          </button>
        </div>
        {!alarms?.length ? (
          <Empty />
        ) : (
          <div className="table-wrap tall">
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{S.common.state}</th>
                  <th>{S.common.severity}</th>
                  <th>{S.common.source}</th>
                  <th>{S.common.equipment}</th>
                  <th>{S.common.code}</th>
                  <th>{S.common.message}</th>
                  <th className="num">{S.common.count}</th>
                  <th>{S.ams.raised}</th>
                  <th>{S.ams.acked}</th>
                  <th className="num">{S.ams.escalation}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {alarms.map((a) => (
                  <tr key={a.id}>
                    <td className="num">{a.id}</td>
                    <td>
                      <StatePill state={a.state} label={S.ams.states[a.state]} />
                      {a.shelved && <span className="muted"> · shelved</span>}
                    </td>
                    <td>
                      <SevPill sev={a.severity} />
                    </td>
                    <td>{a.source}</td>
                    <td>
                      {a.eqpId}
                      {a.chamberId ? `/${a.chamberId}` : ""}
                    </td>
                    <td className="mono">{a.code}</td>
                    <td style={{ maxWidth: 420 }}>{a.text}</td>
                    <td className="num">{a.count}</td>
                    <td className="num">
                      {fmtTime(a.raisedAt)}
                      <div className="muted">{fmtDuration((now - a.raisedAt) / 1000)}</div>
                    </td>
                    <td className="num">{a.ackedAt ? `${fmtTime(a.ackedAt)} ${a.ackedBy ?? ""}` : "—"}</td>
                    <td className="num">{a.escalation ? `L${a.escalation}` : ""}</td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                        {(a.state === "ACTIVE" || a.state === "CLEARED") && (
                          <button className="btn small primary" onClick={() => ack(a.id)}>
                            {S.ams.ack}
                          </button>
                        )}
                        {a.state !== "CLOSED" && (
                          <button className="btn small" onClick={() => closeAlarm(a.id)}>
                            {S.ams.closeAlarm}
                          </button>
                        )}
                        {a.state !== "CLOSED" && !a.shelved && (
                          <button className="btn small ghost" onClick={() => shelve(a)}>
                            {S.ams.shelve}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3>{S.ams.notifyLog}</h3>
          {!notes?.length ? (
            <Empty />
          ) : (
            <div className="table-wrap tall">
              <table className="t">
                <thead>
                  <tr>
                    <th>{S.common.time}</th>
                    <th>{S.ams.group}</th>
                    <th>{S.ams.channel}</th>
                    <th>{S.common.message}</th>
                  </tr>
                </thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td className="num">{fmtTime(n.ts)}</td>
                      <td>
                        {n.group}
                        <div className="muted" style={{ fontSize: 11 }}>
                          {n.reason} · {n.recipients.join(", ")}
                        </div>
                      </td>
                      <td>{n.channels.join("/")}</td>
                      <td style={{ fontSize: 11.5 }}>{n.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card stack">
          <h3>{S.ams.topCodes}</h3>
          {stats?.topCodes.length ? (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>{S.common.code}</th>
                    <th>{S.common.source}</th>
                    <th className="num">{S.common.count}</th>
                    <th style={{ width: "40%" }} />
                  </tr>
                </thead>
                <tbody>
                  {stats.topCodes.map((c) => (
                    <tr key={c.code}>
                      <td className="mono">{c.code}</td>
                      <td>{c.source}</td>
                      <td className="num">{c.count}</td>
                      <td>
                        <div style={{ height: 10, borderRadius: "0 4px 4px 0", background: "var(--series-1)", width: `${(c.count / stats.topCodes[0].count) * 100}%`, maxWidth: "100%" }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty />
          )}
          {cfg && (
            <Collapsible title={S.ams.rules} defaultOpen>
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>{S.flow.enabled}</th>
                      <th>{S.common.message}</th>
                      <th>{S.ams.minSeverity}</th>
                      <th>{S.common.source}</th>
                      <th>{S.ams.group}</th>
                      <th>{S.ams.channel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfg.rules.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <input type="checkbox" checked={r.enabled} onChange={(e) => toggleRule(r.id, e.target.checked)} aria-label={r.name} />
                        </td>
                        <td>{r.name}</td>
                        <td>
                          <SevPill sev={r.minSeverity} />
                        </td>
                        <td>{r.sources.join(", ")}</td>
                        <td>{r.group}</td>
                        <td>{r.channels.join("/")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ fontSize: 12 }}>
                {S.ams.escalation}: {cfg.escalation.map((e, i) => `L${i + 1} ${e.afterSec}s → ${e.group}`).join(" · ")} ({cfg.escalationMinSeverity}+) · flood ≥ {cfg.floodThreshold}/{cfg.floodWindowSec}s
              </p>
            </Collapsible>
          )}
        </div>
      </div>
    </div>
  );
}
