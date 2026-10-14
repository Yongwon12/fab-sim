import { useEffect, useState } from "react";
import type { CommandAction, EquipmentConfig, EquipmentStatus, ParamMapping } from "../../../shared/types";
import { S } from "../../strings";
import { api } from "../../api";
import { act, go, store, useBoot, useLive, useStatus, type VendorInfo } from "../../store";
import { fmtNum } from "../../format";
import { E10Pill, Empty, StatePill, Tabs, VendorTag } from "../../components/ui";
import { useEquipmentFeed } from "./feed";
import { TracePanel } from "./TracePanel";
import { RecipePanel } from "./RecipePanel";
import { AlarmsPanel } from "./AlarmsPanel";
import { EventsPanel } from "./EventsPanel";
import { GenerationPanel } from "./GenerationPanel";
import { FaultsPanel } from "./FaultsPanel";
import { NativePanel } from "./NativePanel";

const TABS = ["overview", "trace", "recipe", "alarms", "events", "generation", "faults", "native"] as const;
type Tab = (typeof TABS)[number];

export interface EquipmentDetail {
  config: EquipmentConfig;
  status: EquipmentStatus;
  mappings: ParamMapping[];
  vendor: VendorInfo;
}

export function ConsoleView({ eqpId, tab }: { eqpId?: string; tab?: string }) {
  const boot = useBoot()!;
  const live = useLive();
  const list = boot.equipment;
  const selected = list.find((e) => e.id === eqpId) ?? list[0];

  useEffect(() => {
    if (selected && selected.id !== eqpId) go("console", selected.id, tab ?? "overview");
  }, [selected, eqpId, tab]);

  return (
    <div className="console">
      <aside className="eqlist" aria-label={S.console.equipmentList}>
        <div className="row" style={{ justifyContent: "space-between", padding: "2px 4px 6px" }}>
          <h4>{S.console.equipmentList}</h4>
          <a className="btn small" href="#/scenario">
            + {S.console.addEquipment}
          </a>
        </div>
        {list.map((e) => {
          const st = live.status.find((s) => s.id === e.id);
          return (
            <button key={e.id} className={`eqitem ${selected?.id === e.id ? "on" : ""}`} onClick={() => go("console", e.id, tab ?? "overview")}>
              <i className="dot" style={{ background: st ? `var(--e10-${st.e10})` : "var(--e10-NST)" }} title={st?.e10} />
              <span className="name">{e.id}</span>
              <span className="row" style={{ gap: 4 }}>
                {st && st.activeAlarms.length > 0 && <span className="badge-count">{st.activeAlarms.length}</span>}
                <VendorTag vendor={e.vendor} />
              </span>
              <span className="meta">
                {e.name} · {st ? `${st.e10} · ${st.controlState.replace("ONLINE_", "")}` : ""}
              </span>
            </button>
          );
        })}
        {!list.length && <Empty>{S.console.noEquipment}</Empty>}
      </aside>
      <section className="eq-main">{selected ? <EquipmentPanel key={selected.id} cfg={selected} tab={(TABS as readonly string[]).includes(tab ?? "") ? (tab as Tab) : "overview"} /> : null}</section>
    </div>
  );
}

function EquipmentPanel({ cfg, tab }: { cfg: EquipmentConfig; tab: Tab }) {
  const boot = useBoot()!;
  const status = useStatus(cfg.id);
  const live = useLive();
  const { feed, version } = useEquipmentFeed(cfg.id);
  const [mappings, setMappings] = useState<ParamMapping[]>([]);
  const vendor = boot.vendors.find((v) => v.id === cfg.vendor)!;

  useEffect(() => {
    api.get<EquipmentDetail>(`/api/equipment/${encodeURIComponent(cfg.id)}`).then((d) => setMappings(d.mappings), () => undefined);
  }, [cfg]);

  const save = async (next: EquipmentConfig) => {
    const r = await act(() => api.put<EquipmentConfig>(`/api/equipment/${encodeURIComponent(cfg.id)}`, next), S.common.saved);
    if (r) await store.loadBootstrap();
    return !!r;
  };

  if (!status) return <Empty>{S.common.loading}</Empty>;
  const now = live.sim?.simTime ?? Date.now();

  return (
    <div className="page">
      <div className="eq-head">
        <div className="eq-title stack" style={{ gap: 4 }}>
          <div className="row">
            <h2>{cfg.id}</h2>
            <span className="secondary">{cfg.name}</span>
          </div>
          <div className="row">
            <E10Pill state={status.e10} since={status.e10Since} now={now} />
            <StatePill state={status.controlState} label={S.console.online[status.controlState]} />
            <StatePill state={status.processState} />
            {status.mode !== "PRODUCTION" && <StatePill state="WARN" label={S.console.modes[status.mode]} />}
            {status.pm && <StatePill state="PM" label="PM" />}
            {status.holdReason && <StatePill state="HOLD" label={`${S.console.hold}: ${status.holdReason}`} />}
          </div>
        </div>
        <dl className="kv" style={{ marginLeft: "auto" }}>
          <dt>{S.console.vendor}</dt>
          <dd>
            <VendorTag vendor={cfg.vendor} /> {vendor?.name}
          </dd>
          <dt>{S.console.model}</dt>
          <dd>
            {cfg.model} · {cfg.type} · {cfg.area}
          </dd>
          <dt>{S.console.protocol}</dt>
          <dd>{vendor?.protocol}</dd>
          <dt>{S.console.wafers}</dt>
          <dd className="num">
            {status.wafersProcessed} / {S.console.lots} {status.lotsProcessed}
          </dd>
        </dl>
      </div>
      <CommandBar cfg={cfg} status={status} />
      {status.controlState === "OFFLINE" && <div className="note">{S.console.offlineNote}</div>}
      <Tabs
        tabs={TABS.map((t) => [t, t === "alarms" && status.activeAlarms.length ? `${S.console.tabs[t]} (${status.activeAlarms.length})` : S.console.tabs[t]] as [Tab, string])}
        value={tab}
        onChange={(t) => go("console", cfg.id, t)}
      />
      {tab === "overview" && <Overview cfg={cfg} status={status} />}
      {tab === "trace" && <TracePanel cfg={cfg} feed={feed} version={version} />}
      {tab === "recipe" && <RecipePanel cfg={cfg} onSave={save} />}
      {tab === "alarms" && <AlarmsPanel cfg={cfg} status={status} />}
      {tab === "events" && <EventsPanel cfg={cfg} feed={feed} version={version} />}
      {tab === "generation" && <GenerationPanel cfg={cfg} onSave={save} />}
      {tab === "faults" && <FaultsPanel cfg={cfg} />}
      {tab === "native" && <NativePanel cfg={cfg} mappings={mappings} vendor={vendor} />}
    </div>
  );
}

function CommandBar({ cfg, status }: { cfg: EquipmentConfig; status: EquipmentStatus }) {
  const [viaHost, setViaHost] = useState(false);
  const [recipeId, setRecipeId] = useState(cfg.generation.defaultRecipeId || cfg.recipes[0]?.id);
  const [wafers, setWafers] = useState(cfg.generation.wafersPerLot);
  const send = (action: CommandAction, args: Record<string, string | number | boolean> = {}) =>
    act(() => api.post(`/api/equipment/${encodeURIComponent(cfg.id)}/${viaHost ? "host-command" : "command"}`, { action, args }));
  const loaded = status.loadPorts.find((p) => p.state === "LOADED");
  const hasRuns = status.processState !== "IDLE";
  const busyPorts = status.loadPorts.some((p) => p.state === "PROCESSING");

  return (
    <div className="cmdbar" aria-label={S.console.commands}>
      <div className="seg" role="group" aria-label={S.console.control}>
        {(["ONLINE_REMOTE", "ONLINE_LOCAL", "OFFLINE"] as const).map((c) => (
          <button key={c} className={status.controlState === c ? "on" : ""} onClick={() => send(c)}>
            {S.console.online[c]}
          </button>
        ))}
      </div>
      <span className="sep" />
      <select value={recipeId} onChange={(e) => setRecipeId(e.target.value)} aria-label={S.common.recipe}>
        {cfg.recipes.map((r) => (
          <option key={r.id} value={r.id}>
            {r.id}
          </option>
        ))}
      </select>
      <input type="number" min={1} max={25} value={wafers} onChange={(e) => setWafers(Number(e.target.value))} style={{ width: 60 }} aria-label={S.console.waferCount} title={S.console.waferCount} />
      <button className="btn" onClick={() => send("LOAD_CARRIER", { recipeId, wafers })} disabled={!status.loadPorts.some((p) => p.state === "EMPTY")}>
        {S.console.loadCarrier}
      </button>
      <button className="btn primary" onClick={() => send("START_LOT", { port: loaded?.id ?? 0 })} disabled={!loaded}>
        {S.console.startLot}
      </button>
      <span className="sep" />
      {status.processState === "PAUSED" && status.activeAlarms.every((a) => !a.stopsEquipment) ? (
        <button className="btn" onClick={() => send("RESUME")}>
          {S.console.resume}
        </button>
      ) : (
        <button className="btn" onClick={() => send(status.processState === "PAUSED" ? "RESUME" : "PAUSE")} disabled={!hasRuns}>
          {status.processState === "PAUSED" ? S.console.resume : S.console.pause}
        </button>
      )}
      <button className="btn danger" onClick={() => window.confirm(`${cfg.id} ${S.console.abort}?`) && send("ABORT")} disabled={!hasRuns && !busyPorts}>
        {S.console.abort}
      </button>
      <button className="btn" onClick={() => send("ALARM_RESET")} disabled={!status.activeAlarms.length}>
        {S.console.alarmReset}
      </button>
      {status.holdReason && status.holdReason !== "PM pending" && (
        <button className="btn" onClick={() => send("RELEASE_HOLD")}>
          {S.console.releaseHold}
        </button>
      )}
      <span className="sep" />
      <button className="btn" onClick={() => send(status.pm ? "PM_END" : "PM_START")}>
        {status.pm ? S.console.pmEnd : S.console.pmStart}
      </button>
      <select value={status.mode} onChange={(e) => send("SET_MODE", { mode: e.target.value })} aria-label={S.console.mode}>
        {(["PRODUCTION", "ENGINEERING", "NONSCHEDULED"] as const).map((m) => (
          <option key={m} value={m}>
            {S.console.modes[m]}
          </option>
        ))}
      </select>
      <label className="check" style={{ marginLeft: "auto" }} title="S2F41 / XML Command / OPC UA Call">
        <input type="checkbox" checked={viaHost} onChange={(e) => setViaHost(e.target.checked)} />
        {S.console.viaHost}
      </label>
    </div>
  );
}

function Overview({ cfg, status }: { cfg: EquipmentConfig; status: EquipmentStatus }) {
  const params = cfg.parameters;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <h4>{S.console.chambers}</h4>
      <div className="chambers">
        {status.chambers.map((ch) => (
          <div className="chamber" key={ch.id}>
            <div className="chamber-head">
              <b>{ch.id}</b>
              <StatePill state={ch.state} />
            </div>
            {ch.run ? (
              <div className="stack" style={{ gap: 4 }}>
                <div className="secondary" style={{ fontSize: 12 }}>
                  {ch.run.recipeId} · {S.common.lot} {ch.run.lotId} · {ch.run.waferIds.length > 1 ? `${ch.run.waferIds.length} wafers` : ch.run.waferIds[0]}
                </div>
                <div style={{ fontSize: 12 }}>
                  {S.common.step} {ch.run.stepNo} <b>{ch.run.stepName}</b>{" "}
                  <span className="muted num">
                    {ch.stepElapsed.toFixed(0)}/{ch.stepDuration}s · run {ch.runElapsed.toFixed(0)}/{ch.runDuration}s
                  </span>
                </div>
                <div className="progress" title={S.console.stepProgress}>
                  <div style={{ width: `${Math.min(100, (ch.stepElapsed / Math.max(1, ch.stepDuration)) * 100)}%` }} />
                </div>
                <div className="progress" title={S.console.runProgress}>
                  <div style={{ width: `${Math.min(100, (ch.runElapsed / Math.max(1, ch.runDuration)) * 100)}%`, background: "var(--series-3)" }} />
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>
                {S.console.idle}
              </div>
            )}
            <div className="values">
              <span className="muted" style={{ fontSize: 11 }}>
                {S.common.parameter}
              </span>
              <span className="muted" style={{ fontSize: 11, textAlign: "right" }}>
                PV
              </span>
              <span className="muted" style={{ fontSize: 11, textAlign: "right" }}>
                {S.console.sp}
              </span>
              {params.map((p) => {
                const v = ch.values[p.key];
                const sp = ch.setpoints[p.key];
                const off = Math.abs(v - sp) > 3 * p.tolerance && ch.state === "PROCESSING";
                return (
                  <FragmentRow key={p.key} label={`${p.name} (${p.unit})`} value={fmtNum(v, 4)} sp={fmtNum(sp, 4)} off={off} />
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {S.console.wafersSincePm}: {ch.wafersSincePm}
              {cfg.generation.pmIntervalWafers ? ` / ${cfg.generation.pmIntervalWafers}` : ""}
            </div>
          </div>
        ))}
      </div>
      <h4>{S.console.loadPorts}</h4>
      <div className="ports">
        {status.loadPorts.map((p) => (
          <div className="card" key={p.id}>
            <div className="row">
              <b>LP{p.id}</b>
              <StatePill state={p.state === "EMPTY" ? "IDLE" : p.state === "COMPLETE" ? "OK" : p.state === "LOADED" ? "WARN" : "PROCESSING"} label={p.state} />
              <span className="secondary" style={{ fontSize: 12 }}>
                {p.carrierId ? `${p.carrierId} · ${p.lotId} · ${p.recipeId}` : ""}
              </span>
            </div>
            <div className="slots" aria-label="slot map">
              {Array.from({ length: 25 }, (_, i) => p.slots[i] ?? "EMPTY").map((s, i) => (
                <div key={i} className={`slot ${s}`} title={`slot ${i + 1}: ${s}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="swatch" style={{ background: "color-mix(in srgb, var(--accent) 35%, var(--surface-3))" }} /> WAITING
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--accent)" }} /> PROCESSING
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--good)" }} /> DONE
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--critical)" }} /> ABORTED
        </span>
      </div>
    </div>
  );
}

function FragmentRow({ label, value, sp, off }: { label: string; value: string; sp: string; off: boolean }) {
  return (
    <>
      <span className="k" title={label}>
        {label}
      </span>
      <span className={`v ${off ? "off" : ""}`}>
        {value}
        {off ? " ⚠" : ""}
      </span>
      <span className="sp">{sp}</span>
    </>
  );
}
