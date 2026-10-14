import type {
  E10State,
  Envelope,
  EquipmentInfoPayload,
  EventPayload,
  LinkPayload,
  MetrologyPayload,
  StatePayload,
  SystemAlarmPayload,
  ControlState,
  AlarmPayload,
} from "../../shared/types";
import { topics } from "../../shared/topics";
import type { MessageBus } from "../bus/message-bus";
import type { FabSystem } from "./common";
import { MasterData, matchesFilter, pushRing, round } from "./common";

// EES — Equipment Engineering System.
// Tracks every tool's SEMI E10 state from the host side, accumulates state
// time, derives availability / utilization / OEE / MTBF / MTTR / WPH, keeps
// the ERD (event report) log and lot history, and raises equipment-level
// alerts (long unscheduled down, host link lost) to AMS.

const E10_STATES: E10State[] = ["PRD", "SBY", "ENG", "SDT", "UDT", "NST"];

export interface EesConfig {
  /** Raise an alert when a tool stays UDT longer than this (simulated seconds). */
  udtAlertSec: number;
  /** Window for the KPIs, simulated hours (0 = since start). */
  kpiWindowHours: number;
}

export const DEFAULT_EES_CONFIG: EesConfig = { udtAlertSec: 120, kpiWindowHours: 0 };

interface Segment {
  state: E10State;
  start: number;
  end: number | null;
  reason: string;
}

interface Tracker {
  eqpId: string;
  state: E10State;
  since: number;
  controlState: ControlState;
  online: boolean;
  segments: Segment[];
  firstSeen: number;
  wafers: number;
  lots: number;
  runs: number;
  idealRunSec: number;
  aborted: number;
  alarms: number;
  measured: number;
  inSpec: number;
  udtAlerted: boolean;
  linkAlerted: boolean;
  activeLots: Map<string, LotRecord>;
}

export interface LotRecord {
  lotId: string;
  eqpId: string;
  recipeId: string;
  portId: number;
  carrierId: string;
  waferCount: number;
  processedCount: number;
  start: number;
  end: number | null;
  result: string;
}

export interface EventLogEntry {
  id: number;
  ts: number;
  eqpId: string;
  name: string;
  ceid: number;
  chamberId: string | null;
  values: Record<string, string | number>;
  extra: Record<string, string | number> | null;
}

const MAX_SEGMENTS = 400;
const MAX_EVENTS = 6000;
const MAX_LOTS = 1000;

export class EesSystem implements FabSystem {
  readonly id = "EES" as const;
  config: EesConfig = { ...DEFAULT_EES_CONFIG };
  private master = new MasterData();
  private trackers = new Map<string, Tracker>();
  private events: EventLogEntry[] = [];
  private lots: LotRecord[] = [];
  private eventSeq = 0;
  private now = 0;

  constructor(private bus: MessageBus) {
    bus.subscribe("EES", "eqp/+/info", (m) => this.onInfo(m as Envelope<EquipmentInfoPayload>), "Master data");
    bus.subscribe("EES", "eqp/+/state", (m) => this.onState(m as Envelope<StatePayload>), "E10 / control state");
    bus.subscribe("EES", "eqp/+/link", (m) => this.onLink(m as Envelope<LinkPayload>), "Host link status");
    bus.subscribe("EES", "eqp/+/event", (m) => this.onEvent(m as Envelope<EventPayload>), "ERD event reports");
    bus.subscribe("EES", "eqp/+/alarm", (m) => this.onAlarm(m as Envelope<AlarmPayload>), "Equipment alarms");
    bus.subscribe("EES", "eqp/+/metrology", (m) => this.onMetrology(m as Envelope<MetrologyPayload>), "Quality yield for OEE");
  }

  reset() {
    for (const [id, t] of this.trackers) {
      this.trackers.set(id, this.newTracker(id, this.now, t.state, t.controlState, t.online));
    }
    this.events = [];
    this.lots = [];
  }

  private newTracker(eqpId: string, ts: number, state: E10State = "SBY", controlState: ControlState = "ONLINE_REMOTE", online = true): Tracker {
    return {
      eqpId,
      state,
      since: ts,
      controlState,
      online,
      segments: [{ state, start: ts, end: null, reason: "tracking started" }],
      firstSeen: ts,
      wafers: 0,
      lots: 0,
      runs: 0,
      idealRunSec: 0,
      aborted: 0,
      alarms: 0,
      measured: 0,
      inSpec: 0,
      udtAlerted: false,
      linkAlerted: false,
      activeLots: new Map(),
    };
  }

  private tracker(eqpId: string, ts: number): Tracker {
    let t = this.trackers.get(eqpId);
    if (!t) {
      t = this.newTracker(eqpId, ts);
      this.trackers.set(eqpId, t);
    }
    return t;
  }

  // ------------------------------------------------------------ inputs

  private onInfo(m: Envelope<EquipmentInfoPayload>) {
    this.master.apply(m.payload);
    if (m.payload.removed) this.trackers.delete(m.payload.eqpId);
    else this.tracker(m.payload.eqpId, m.ts);
  }

  private onState(m: Envelope<StatePayload>) {
    const s = m.payload;
    const t = this.tracker(s.eqpId, m.ts);
    t.controlState = s.controlState;
    if (s.e10 === t.state) return;
    const last = t.segments[t.segments.length - 1];
    if (last) last.end = m.ts;
    pushRing(t.segments, { state: s.e10, start: m.ts, end: null, reason: s.reason }, MAX_SEGMENTS);
    if (t.state === "UDT" && t.udtAlerted) {
      t.udtAlerted = false;
      this.alert(t.eqpId, "EES-LONG-UDT", "Long unscheduled down cleared", "MAJOR", false, m.ts);
    }
    t.state = s.e10;
    t.since = m.ts;
  }

  private onLink(m: Envelope<LinkPayload>) {
    const t = this.tracker(m.payload.eqpId, m.ts);
    t.online = m.payload.online;
    t.controlState = m.payload.controlState;
    if (!t.online && !t.linkAlerted) {
      t.linkAlerted = true;
      this.alert(t.eqpId, "EES-LINK-OFFLINE", "Equipment went OFFLINE: no data reaches the host", "WARNING", true, m.ts);
    } else if (t.online && t.linkAlerted) {
      t.linkAlerted = false;
      this.alert(t.eqpId, "EES-LINK-OFFLINE", "Equipment back ONLINE", "WARNING", false, m.ts);
    }
  }

  private onAlarm(m: Envelope<AlarmPayload>) {
    if (m.payload.set) this.tracker(m.payload.eqpId, m.ts).alarms++;
  }

  private onMetrology(m: Envelope<MetrologyPayload>) {
    const t = this.tracker(m.payload.eqpId, m.ts);
    t.measured++;
    const ok = m.payload.items.every((i) => (i.usl === undefined || i.value <= i.usl) && (i.lsl === undefined || i.value >= i.lsl));
    if (ok) t.inSpec++;
  }

  private onEvent(m: Envelope<EventPayload>) {
    const e = m.payload;
    const base = e.reports[0]?.values ?? {};
    const extra = e.reports[1]?.values ?? null;
    pushRing(
      this.events,
      { id: ++this.eventSeq, ts: m.ts, eqpId: e.eqpId, name: e.name, ceid: e.ceid, chamberId: e.chamberId, values: base, extra },
      MAX_EVENTS,
    );
    const t = this.tracker(e.eqpId, m.ts);
    switch (e.name) {
      case "LOT_START": {
        const lot: LotRecord = {
          lotId: String(base.LotID),
          eqpId: e.eqpId,
          recipeId: String(base.RecipeID ?? ""),
          portId: Number(base.PortID ?? 0),
          carrierId: String(base.CarrierID ?? ""),
          waferCount: Number(base.WaferCount ?? 0),
          processedCount: 0,
          start: m.ts,
          end: null,
          result: "PROCESSING",
        };
        t.activeLots.set(lot.lotId, lot);
        pushRing(this.lots, lot, MAX_LOTS);
        break;
      }
      case "LOT_END": {
        const lot = t.activeLots.get(String(base.LotID));
        t.lots++;
        if (lot) {
          lot.end = m.ts;
          lot.processedCount = Number(base.ProcessedCount ?? 0);
          lot.result = String(base.Result ?? "OK");
          t.activeLots.delete(lot.lotId);
        }
        break;
      }
      case "PROCESS_END": {
        const wafers = String(base.WaferID ?? "").split(",").filter(Boolean).length || 1;
        t.wafers += wafers;
        t.runs++;
        const info = this.master.get(e.eqpId);
        const recipe = info?.recipes.find((r) => r.id === base.RecipeID);
        t.idealRunSec += recipe ? recipe.steps.reduce((s, x) => s + x.duration, 0) : Number(base.ProcessTime ?? 0);
        break;
      }
      case "PROCESS_ABORTED":
        t.aborted += String(base.WaferID ?? "").split(",").filter(Boolean).length || 1;
        break;
    }
  }

  tick(now: number) {
    this.now = now;
    for (const t of this.trackers.values()) {
      if (t.state === "UDT" && !t.udtAlerted && now - t.since > this.config.udtAlertSec * 1000) {
        t.udtAlerted = true;
        this.alert(
          t.eqpId,
          "EES-LONG-UDT",
          `Unscheduled down for more than ${this.config.udtAlertSec}s`,
          "MAJOR",
          true,
          now,
        );
      }
    }
  }

  private alert(eqpId: string, code: string, text: string, severity: SystemAlarmPayload["severity"], set: boolean, ts: number) {
    const payload: SystemAlarmPayload = { eqpId, code, text, severity, set };
    this.bus.publish(topics.eesAlarm, "ees.alarm", "EES", payload, ts);
  }

  // -------------------------------------------------------------- KPIs

  private durations(t: Tracker, now: number): Record<E10State, number> {
    const from = this.config.kpiWindowHours > 0 ? now - this.config.kpiWindowHours * 3_600_000 : -Infinity;
    const d = Object.fromEntries(E10_STATES.map((s) => [s, 0])) as Record<E10State, number>;
    for (const seg of t.segments) {
      const start = Math.max(seg.start, from);
      const end = seg.end ?? now;
      if (end > start) d[seg.state] += end - start;
    }
    return d;
  }

  kpis(eqpId: string, now = this.now) {
    const t = this.trackers.get(eqpId);
    if (!t) return undefined;
    const d = this.durations(t, now);
    const total = E10_STATES.reduce((s, k) => s + d[k], 0);
    const operational = total - d.NST;
    const uptime = d.PRD + d.SBY + d.ENG;
    const chambers = this.master.get(eqpId)?.chambers.length ?? 1;
    const availability = operational > 0 ? uptime / operational : 0;
    const utilization = operational > 0 ? d.PRD / operational : 0;
    const performance = d.PRD > 0 ? Math.min(1, (t.idealRunSec * 1000) / (d.PRD * chambers)) : 0;
    const quality = t.measured > 0 ? t.inSpec / t.measured : 1;
    const failures = t.segments.filter((s) => s.state === "UDT").length;
    return {
      eqpId,
      state: t.state,
      since: t.since,
      controlState: t.controlState,
      online: t.online,
      durations: Object.fromEntries(E10_STATES.map((s) => [s, round(d[s] / 1000, 1)])) as Record<E10State, number>,
      totalSec: round(total / 1000, 1),
      availability: round(availability, 4),
      utilization: round(utilization, 4),
      performance: round(performance, 4),
      quality: round(quality, 4),
      oee: round(availability * performance * quality, 4),
      mtbfSec: failures ? round((d.PRD + d.SBY) / 1000 / failures, 1) : null,
      mttrSec: failures ? round(d.UDT / 1000 / failures, 1) : null,
      wph: operational > 0 ? round(t.wafers / (operational / 3_600_000), 2) : 0,
      wafers: t.wafers,
      lots: t.lots,
      runs: t.runs,
      aborted: t.aborted,
      alarms: t.alarms,
      activeLots: t.activeLots.size,
    };
  }

  overview(now = this.now) {
    return this.master
      .all()
      .map((info) => ({ ...this.kpis(info.eqpId, now)!, name: info.name, type: info.type, vendor: info.vendor, model: info.model, area: info.area }))
      .filter((k) => k.eqpId);
  }

  timeline(eqpId: string, sinceMs: number) {
    const t = this.trackers.get(eqpId);
    if (!t) return [];
    return t.segments.filter((s) => (s.end ?? Infinity) >= sinceMs);
  }

  listEvents(filter: { eqpId?: string; name?: string; lotId?: string; limit?: number }) {
    const out: EventLogEntry[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < (filter.limit ?? 200); i--) {
      const e = this.events[i];
      if (!matchesFilter(e.eqpId, filter.eqpId) || !matchesFilter(e.name, filter.name)) continue;
      if (filter.lotId && e.values.LotID !== filter.lotId) continue;
      out.push(e);
    }
    return out;
  }

  listLots(filter: { eqpId?: string; limit?: number }) {
    const out: LotRecord[] = [];
    for (let i = this.lots.length - 1; i >= 0 && out.length < (filter.limit ?? 200); i--) {
      if (matchesFilter(this.lots[i].eqpId, filter.eqpId)) out.push(this.lots[i]);
    }
    return out;
  }

  eventCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.events) out[e.name] = (out[e.name] ?? 0) + 1;
    return out;
  }

  setConfig(patch: Partial<EesConfig>) {
    this.config = { ...this.config, ...patch };
    return this.config;
  }
}
