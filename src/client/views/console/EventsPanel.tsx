import { useState } from "react";
import type { EquipmentConfig } from "../../../shared/types";
import { S } from "../../strings";
import { useBoot } from "../../store";
import { fmtTime } from "../../format";
import { saveExport } from "../../api";
import { Empty } from "../../components/ui";
import type { EquipmentFeed } from "./feed";

export function EventsPanel({ cfg, feed, version }: { cfg: EquipmentConfig; feed: EquipmentFeed; version: number }) {
  const boot = useBoot()!;
  const [name, setName] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  void version;
  const events = [...feed.events].reverse().filter((e) => !name || e.payload.name === name).slice(0, 300);

  return (
    <div className="card">
      <div className="card-head">
        <h3>{S.events.live}</h3>
        <select value={name} onChange={(e) => setName(e.target.value)} aria-label={S.events.filterName}>
          <option value="">{S.common.all}</option>
          {boot.eventNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => saveExport(`/api/export/events.csv?eqpId=${encodeURIComponent(cfg.id)}`)}>
          CSV
        </button>
      </div>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        {S.events.hint}
      </p>
      {!events.length ? (
        <Empty />
      ) : (
        <div className="table-wrap tall">
          <table className="t">
            <thead>
              <tr>
                <th>{S.common.time}</th>
                <th>CEID</th>
                <th>Event</th>
                <th>{S.common.chamber}</th>
                <th>{S.events.report}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const base = e.payload.reports[0]?.values ?? {};
                const extra = e.payload.reports[1]?.values;
                const summary = Object.entries(base)
                  .filter(([k]) => !["EqpID", "Clock", "ChamberID"].includes(k))
                  .map(([k, v]) => `${k}=${v}`)
                  .join("  ");
                return (
                  <tr key={e.id} className="click" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="num">{fmtTime(e.ts)}</td>
                    <td className="num">{e.payload.ceid}</td>
                    <td className="mono">{e.payload.name}</td>
                    <td>{e.payload.chamberId ?? "—"}</td>
                    <td>
                      {open === e.id ? (
                        <pre className="frame-text" style={{ maxHeight: 260 }}>
                          {JSON.stringify(e.payload.reports, null, 2)}
                        </pre>
                      ) : (
                        <span className="secondary" style={{ fontSize: 11.5 }}>
                          {summary}
                          {extra ? `  · ${S.events.extra}: ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
