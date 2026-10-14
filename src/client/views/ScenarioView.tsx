import { useRef, useState } from "react";
import type { EquipmentType, VendorId } from "../../shared/types";
import { S } from "../strings";
import { api } from "../api";
import { act, go, store, toasts, useBoot, useLive } from "../store";
import { download } from "../format";
import { Empty, VendorTag } from "../components/ui";

export function ScenarioView() {
  const boot = useBoot()!;
  const live = useLive();
  const fileRef = useRef<HTMLInputElement>(null);
  const [seed, setSeed] = useState(String(live.sim?.seed ?? boot.sim.seed));
  const [form, setForm] = useState({ id: "", name: "", type: "ETCH" as EquipmentType, vendor: "VA" as VendorId, chambers: "", loadPorts: 3 });

  const exportScenario = async () => {
    const s = await act(() => api.get("/api/scenario"));
    if (s) download(`fab-sim-scenario-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(s, null, 2));
  };
  const importScenario = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const ok = await act(() => api.put("/api/scenario", json), S.scenario.imported);
      if (ok) await store.loadBootstrap();
    } catch (err) {
      toasts.push((err as Error).message, "error");
    }
  };
  const resetDefaults = async () => {
    if (!window.confirm(S.scenario.confirmReset)) return;
    if (await act(() => api.post("/api/scenario/reset"), S.common.reset)) await store.loadBootstrap();
  };
  const restartSeed = async () => {
    if (await act(() => api.post("/api/sim", { action: "reset", seed: Number(seed) }), `seed ${seed}`)) await store.loadBootstrap();
  };
  const addEquipment = async () => {
    const chambers = form.chambers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const r = await act(
      () => api.post("/api/equipment", { id: form.id.trim(), name: form.name.trim() || undefined, type: form.type, vendor: form.vendor, chambers: chambers.length ? chambers : undefined, loadPorts: form.loadPorts }),
      S.scenario.created,
    );
    if (r) {
      await store.loadBootstrap();
      go("console", form.id.trim(), "overview");
    }
  };
  const removeEquipment = async (id: string) => {
    if (!window.confirm(`${id}: ${S.common.confirmDelete}`)) return;
    if (await act(() => api.del(`/api/equipment/${encodeURIComponent(id)}`), `${id} ${S.common.delete}`)) await store.loadBootstrap();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h2>{S.scenario.title}</h2>
      </div>
      <div className="grid cols-2">
        <div className="card stack">
          <h3>{S.scenario.addTitle}</h3>
          <div className="form-grid">
            <label className="field">
              {S.scenario.id}
              <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="ETCH-03" />
            </label>
            <label className="field">
              {S.scenario.name}
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field">
              {S.scenario.type}
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as EquipmentType })}>
                {boot.templates.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.type} — {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {S.console.vendor}
              <select value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value as VendorId })}>
                {boot.vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id} — {v.name} ({v.protocol})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {S.scenario.chambersCsv}
              <input value={form.chambers} onChange={(e) => setForm({ ...form, chambers: e.target.value })} placeholder={boot.templates.find((t) => t.type === form.type)?.defaultChambers.join(", ")} />
            </label>
            <label className="field">
              {S.console.loadPorts}
              <input type="number" min={1} max={6} value={form.loadPorts} onChange={(e) => setForm({ ...form, loadPorts: Number(e.target.value) })} />
            </label>
          </div>
          <div className="row">
            <button className="btn primary" onClick={addEquipment} disabled={!form.id.trim()}>
              + {S.common.add}
            </button>
          </div>
          <h3 style={{ marginTop: 8 }}>{S.common.equipment}</h3>
          {!boot.equipment.length ? (
            <Empty />
          ) : (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>{S.scenario.name}</th>
                    <th>{S.scenario.type}</th>
                    <th>{S.console.vendor}</th>
                    <th>{S.console.chambers}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {boot.equipment.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <a href={`#/console/${encodeURIComponent(e.id)}/overview`}>{e.id}</a>
                      </td>
                      <td>{e.name}</td>
                      <td>{e.type}</td>
                      <td>
                        <VendorTag vendor={e.vendor} /> {e.model}
                      </td>
                      <td>{e.chambers.join(", ")}</td>
                      <td>
                        <button className="btn small danger" onClick={() => removeEquipment(e.id)}>
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
        <div className="stack" style={{ gap: 12 }}>
          <div className="card stack">
            <h3>{S.scenario.title}</h3>
            <div className="row">
              <button className="btn primary" onClick={exportScenario}>
                {S.scenario.export}
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()}>
                {S.scenario.import}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importScenario(f);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="row">
              <label className="field">
                {S.scenario.seed}
                <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
              </label>
              <button className="btn" style={{ alignSelf: "flex-end" }} onClick={restartSeed}>
                {S.scenario.restart}
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {S.scenario.seedHint}
            </p>
            <div className="row">
              <button className="btn" onClick={() => act(() => api.post("/api/systems/reset"), S.scenario.resetSystems)}>
                {S.scenario.resetSystems}
              </button>
              <button className="btn danger" onClick={resetDefaults}>
                {S.scenario.resetDefaults}
              </button>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {S.scenario.resetSystemsHint}
            </p>
          </div>
          <div className="card stack">
            <h3>{S.scenario.exports}</h3>
            <div className="row">
              <a className="btn" href="/api/export/events.csv">
                {S.scenario.eventsCsv}
              </a>
              <a className="btn" href="/api/export/scenario.json">
                scenario.json
              </a>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              Trace CSV: FDC → Run → {S.fdc.csv}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
