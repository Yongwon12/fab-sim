import { useState } from "react";
import type { EquipmentConfig, FaultInjection, FaultType } from "../../../shared/types";
import { S } from "../../strings";
import { api } from "../../api";
import { act, usePoll } from "../../store";
import { fmtTime } from "../../format";
import { Check, Empty, NumField } from "../../components/ui";

const TYPES: FaultType[] = ["SHIFT", "DRIFT", "SPIKE", "NOISE", "STUCK", "DROPOUT"];

interface Draft {
  chamberId: string;
  param: string;
  type: FaultType;
  magnitude: number;
  probability: number;
  processOnly: boolean;
  durationSec: number;
  note: string;
}

/** Sensible starting magnitudes, relative to the parameter's tolerance. */
function defaultMagnitude(cfg: EquipmentConfig, param: string, type: FaultType): number {
  const p = cfg.parameters.find((x) => x.key === param);
  const tol = p?.tolerance ?? 1;
  switch (type) {
    case "SHIFT":
      return Number((tol * 2).toPrecision(3));
    case "DRIFT":
      return Number((tol * 0.5).toPrecision(3));
    case "SPIKE":
      return Number((tol * 6).toPrecision(3));
    case "NOISE":
      return 5;
    default:
      return 0;
  }
}

export function FaultsPanel({ cfg }: { cfg: EquipmentConfig }) {
  const { data: all, reload } = usePoll<FaultInjection[]>("/api/faults", 3000);
  const faults = (all ?? []).filter((f) => f.eqpId === cfg.id);
  const firstParam = cfg.parameters[0]?.key ?? "";
  const [d, setD] = useState<Draft>({
    chamberId: cfg.chambers[0],
    param: firstParam,
    type: "SHIFT",
    magnitude: defaultMagnitude(cfg, firstParam, "SHIFT"),
    probability: 0.2,
    processOnly: true,
    durationSec: 0,
    note: "",
  });
  const set = (patch: Partial<Draft>) =>
    setD((x) => {
      const next = { ...x, ...patch };
      if (patch.param !== undefined || patch.type !== undefined) next.magnitude = defaultMagnitude(cfg, next.param, next.type);
      return next;
    });
  const unit = cfg.parameters.find((p) => p.key === d.param)?.unit ?? "";

  const add = async () => {
    await act(() => api.post("/api/faults", { ...d, eqpId: cfg.id }), `${d.type} ${d.param}`);
    reload();
  };
  const patch = async (id: string, body: Partial<FaultInjection>) => {
    await act(() => api.patch(`/api/faults/${id}`, body));
    reload();
  };
  const remove = async (id: string) => {
    await act(() => api.del(`/api/faults/${id}`));
    reload();
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card stack">
        <h3>{S.faults.title}</h3>
        <p className="muted" style={{ margin: 0 }}>
          {S.faults.hint}
        </p>
        <div className="form-grid">
          <label className="field">
            {S.common.chamber}
            <select value={d.chamberId} onChange={(e) => set({ chamberId: e.target.value })}>
              {cfg.chambers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value="*">* ({S.common.all})</option>
            </select>
          </label>
          <label className="field">
            {S.common.parameter}
            <select value={d.param} onChange={(e) => set({ param: e.target.value })}>
              {cfg.parameters.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name} ({p.unit})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {S.faults.type}
            <select value={d.type} onChange={(e) => set({ type: e.target.value as FaultType })}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {S.faults.types[t]}
                </option>
              ))}
            </select>
          </label>
          {d.type !== "STUCK" && d.type !== "DROPOUT" && (
            <NumField label={`${S.faults.magnitude} ${d.type === "NOISE" ? "(×)" : `(${unit}${d.type === "DRIFT" ? "/min" : ""})`}`} value={d.magnitude} onChange={(v) => setD((x) => ({ ...x, magnitude: v }))} />
          )}
          {(d.type === "SPIKE" || d.type === "DROPOUT") && (
            <NumField label={S.faults.probability} value={d.probability} min={0} max={1} step={0.05} onChange={(v) => setD((x) => ({ ...x, probability: v }))} />
          )}
          <NumField label={S.faults.duration} value={d.durationSec} min={0} onChange={(v) => setD((x) => ({ ...x, durationSec: v }))} />
          <label className="field">
            {S.faults.note}
            <input value={d.note} onChange={(e) => setD((x) => ({ ...x, note: e.target.value }))} />
          </label>
          <div className="stack" style={{ justifyContent: "flex-end" }}>
            <Check label={S.faults.processOnly} checked={d.processOnly} onChange={(v) => setD((x) => ({ ...x, processOnly: v }))} />
          </div>
        </div>
        <div className="row">
          <button className="btn primary" onClick={add}>
            + {S.common.add}
          </button>
        </div>
      </div>
      <div className="card">
        {!faults.length ? (
          <Empty>{S.faults.noFaults}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{S.faults.enabled}</th>
                  <th>{S.common.chamber}</th>
                  <th>{S.common.parameter}</th>
                  <th>{S.faults.type}</th>
                  <th className="num">{S.faults.magnitude}</th>
                  <th className="num">{S.faults.probability}</th>
                  <th className="num">{S.faults.duration}</th>
                  <th>{S.faults.started}</th>
                  <th>{S.faults.note}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {faults.map((f) => (
                  <tr key={f.id}>
                    <td className="mono">{f.id}</td>
                    <td>
                      <input type="checkbox" checked={f.enabled} onChange={(e) => patch(f.id, { enabled: e.target.checked })} aria-label={S.faults.enabled} />
                    </td>
                    <td>{f.chamberId}</td>
                    <td className="mono">{f.param}</td>
                    <td>{f.type}</td>
                    <td className="num">{f.magnitude}</td>
                    <td className="num">{f.type === "SPIKE" || f.type === "DROPOUT" ? f.probability : "—"}</td>
                    <td className="num">{f.durationSec || "∞"}</td>
                    <td className="num">{fmtTime(f.startedAt)}</td>
                    <td>{f.note}</td>
                    <td>
                      <button className="btn small danger" onClick={() => remove(f.id)}>
                        {S.common.delete}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
