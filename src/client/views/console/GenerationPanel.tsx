import { useEffect, useState } from "react";
import type { EquipmentConfig, EventName, GenerationConfig } from "../../../shared/types";
import { S } from "../../strings";
import { useBoot } from "../../store";
import { Check, NumField } from "../../components/ui";

export function GenerationPanel({ cfg, onSave }: { cfg: EquipmentConfig; onSave: (c: EquipmentConfig) => Promise<boolean> }) {
  const boot = useBoot()!;
  const [g, setG] = useState<GenerationConfig>(() => structuredClone(cfg.generation));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setG(structuredClone(cfg.generation));
    setDirty(false);
  }, [cfg]);
  const set = <K extends keyof GenerationConfig>(k: K, v: GenerationConfig[K]) => {
    setG((x) => ({ ...x, [k]: v }));
    setDirty(true);
  };
  const toggleTraceParam = (k: string) => set("traceParams", g.traceParams.includes(k) ? g.traceParams.filter((x) => x !== k) : [...g.traceParams, k]);
  const toggleEventVar = (e: EventName, k: string) => {
    const cur = g.eventReportVars[e] ?? [];
    set("eventReportVars", { ...g.eventReportVars, [e]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] });
  };
  const save = async () => {
    if (await onSave({ ...cfg, generation: g })) setDirty(false);
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <span className="muted">{S.gen.saveHint}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setG(structuredClone(cfg.generation))} disabled={!dirty}>
          {S.common.cancel}
        </button>
        <button className="btn primary" onClick={save} disabled={!dirty}>
          {S.common.save}
        </button>
      </div>
      <div className="grid cols-2">
        <div className="card stack">
          <h3>{S.gen.trace}</h3>
          <div className="form-grid">
            <Check label={S.gen.traceEnabled} checked={g.traceEnabled} onChange={(v) => set("traceEnabled", v)} />
            <Check label={S.gen.traceIdle} checked={g.traceIdle} onChange={(v) => set("traceIdle", v)} />
            <NumField label={S.gen.traceInterval} value={g.traceIntervalMs} min={100} step={100} onChange={(v) => set("traceIntervalMs", v)} />
          </div>
          <div className="secondary" style={{ fontSize: 12 }}>
            {S.gen.traceParams}
          </div>
          <div className="row">
            {cfg.parameters.map((p) => (
              <Check key={p.key} label={p.name} checked={g.traceParams.includes(p.key)} onChange={() => toggleTraceParam(p.key)} />
            ))}
          </div>
          <h3 style={{ marginTop: 6 }}>{S.gen.signal}</h3>
          <div className="form-grid">
            <NumField label={S.gen.noiseScale} value={g.noiseScale} step={0.1} min={0} onChange={(v) => set("noiseScale", v)} />
            <NumField label={S.gen.drift} value={g.driftPerWafer} step={0.0001} min={0} onChange={(v) => set("driftPerWafer", v)} />
          </div>
        </div>
        <div className="card stack">
          <h3>{S.gen.flow}</h3>
          <div className="form-grid">
            <Check label={S.gen.autoRun} checked={g.autoRun} onChange={(v) => set("autoRun", v)} />
            <label className="field">
              {S.recipe.defaultRecipe}
              <select value={g.defaultRecipeId} onChange={(e) => set("defaultRecipeId", e.target.value)}>
                {cfg.recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
            </label>
            <NumField label={S.gen.lotInterval} value={g.lotIntervalSec} min={10} onChange={(v) => set("lotIntervalSec", v)} />
            <NumField label={S.gen.wafersPerLot} value={g.wafersPerLot} min={1} max={25} step={1} onChange={(v) => set("wafersPerLot", v)} />
            <NumField label={S.gen.transfer} value={g.transferSec} min={0} onChange={(v) => set("transferSec", v)} />
            <NumField label={S.gen.metrology} value={g.metrologyRate} min={0} max={1} step={0.05} onChange={(v) => set("metrologyRate", v)} />
          </div>
          <h3 style={{ marginTop: 6 }}>{S.gen.alarmsTitle}</h3>
          <div className="form-grid">
            <NumField label={S.gen.alarmRate} value={g.alarmRatePerHour} min={0} step={0.5} onChange={(v) => set("alarmRatePerHour", v)} />
            <NumField label={S.gen.autoRecover} value={g.autoRecoverSec} min={0} onChange={(v) => set("autoRecoverSec", v)} />
            <NumField label={S.gen.pmInterval} value={g.pmIntervalWafers} min={0} step={10} onChange={(v) => set("pmIntervalWafers", v)} />
            <NumField label={S.gen.pmDuration} value={g.pmDurationSec} min={0} onChange={(v) => set("pmDurationSec", v)} />
          </div>
        </div>
      </div>
      <div className="card">
        <h3>{S.gen.eventsTitle}</h3>
        <div className="table-wrap tall">
          <table className="t">
            <thead>
              <tr>
                <th>Event</th>
                <th>{S.gen.eventEnabled}</th>
                <th>{S.gen.eventVars}</th>
              </tr>
            </thead>
            <tbody>
              {boot.eventNames.map((e) => (
                <tr key={e}>
                  <td className="mono">{e}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={g.eventsEnabled[e] !== false}
                      onChange={(ev) => set("eventsEnabled", { ...g.eventsEnabled, [e]: ev.target.checked })}
                      aria-label={`${e} ${S.gen.eventEnabled}`}
                    />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {cfg.parameters.map((p) => {
                        const on = (g.eventReportVars[e] ?? []).includes(p.key);
                        return (
                          <button key={p.key} className="btn small" style={on ? { background: "var(--accent-wash)", color: "var(--accent)", borderColor: "var(--accent)" } : undefined} onClick={() => toggleEventVar(e, p.key)}>
                            {p.key}
                          </button>
                        );
                      })}
                    </div>
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
