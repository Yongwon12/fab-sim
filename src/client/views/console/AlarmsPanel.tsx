import type { EquipmentConfig, EquipmentStatus } from "../../../shared/types";
import { S } from "../../strings";
import { api } from "../../api";
import { act, useLive } from "../../store";
import { fmtDuration, fmtTime } from "../../format";
import { Empty, SevPill } from "../../components/ui";

export function AlarmsPanel({ cfg, status }: { cfg: EquipmentConfig; status: EquipmentStatus }) {
  const live = useLive();
  const now = live.sim?.simTime ?? Date.now();
  const cmd = (action: string, args: Record<string, string> = {}) =>
    act(() => api.post(`/api/equipment/${encodeURIComponent(cfg.id)}/command`, { action, args }));

  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="card-head">
          <h3>{S.alarms.active}</h3>
          <button className="btn small" onClick={() => cmd("ALARM_RESET")} disabled={!status.activeAlarms.length}>
            {S.console.alarmReset}
          </button>
        </div>
        {!status.activeAlarms.length ? (
          <Empty>{S.alarms.noActive}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>{S.common.severity}</th>
                  <th>ALID</th>
                  <th>{S.common.code}</th>
                  <th>{S.common.message}</th>
                  <th>{S.common.chamber}</th>
                  <th>{S.common.time}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {status.activeAlarms.map((a) => (
                  <tr key={`${a.code}|${a.chamberId}`}>
                    <td>
                      <SevPill sev={a.severity} />
                    </td>
                    <td className="num">{a.alid}</td>
                    <td className="mono">{a.code}</td>
                    <td>
                      {a.text}
                      {a.stopsEquipment && <span className="muted"> · {S.alarms.stops}</span>}
                    </td>
                    <td>{a.chamberId ?? "—"}</td>
                    <td className="num">
                      {fmtTime(a.setAt)} <span className="muted">({fmtDuration((now - a.setAt) / 1000)})</span>
                    </td>
                    <td>
                      <button className="btn small" onClick={() => cmd("ALARM_RESET", { code: a.code })}>
                        {S.alarms.reset}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h3>{S.alarms.definitions}</h3>
        <div className="table-wrap tall">
          <table className="t">
            <thead>
              <tr>
                <th>ALID</th>
                <th>{S.common.code}</th>
                <th>{S.common.message}</th>
                <th>{S.common.severity}</th>
                <th>{S.alarms.category}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cfg.alarms.map((a) => (
                <tr key={a.code}>
                  <td className="num">{a.alid}</td>
                  <td className="mono">{a.code}</td>
                  <td>
                    {a.text}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {a.stopsEquipment ? S.alarms.stops : ""}
                      {a.autoClearSec ? ` ${S.alarms.autoClear} ${a.autoClearSec}s` : ""}
                      {a.param ? ` ${S.alarms.interlock}: ${a.param}` : ""}
                    </div>
                  </td>
                  <td>
                    <SevPill sev={a.severity} />
                  </td>
                  <td>{a.category}</td>
                  <td>
                    <select
                      className="btn small"
                      value=""
                      onChange={(e) => e.target.value && cmd("RAISE_ALARM", { code: a.code, ...(e.target.value === "-" ? {} : { chamberId: e.target.value }) })}
                      aria-label={S.alarms.raise}
                    >
                      <option value="">{S.alarms.raise} ▾</option>
                      <option value="-">{cfg.id}</option>
                      {cfg.chambers.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
