import type {
  CommandPayload,
  Envelope,
  EquipmentInfoPayload,
  EventPayload,
  FdcRunPayload,
  MetrologyPayload,
  QmsLotPayload,
  Severity,
  SystemAlarmPayload,
} from "../../shared/types";
import { topics } from "../../shared/topics";
import type { MessageBus } from "../bus/message-bus";
import type { FabSystem } from "./common";
import { MasterData, matchesFilter, mean, pushRing, round, std } from "./common";

// QMS — Quality Management System.
// Receives metrology results per wafer, keeps an individuals SPC chart per
// equipment × item, learns control limits (moving-range sigma), applies
// Western Electric rules, computes Cp/Cpk, holds lots on out-of-spec results
// and lets the user disposition them. Optionally inhibits a tool after
// consecutive OOS lots. FDC run verdicts are kept next to the points so a
// quality excursion can be traced back to the run that caused it.

export type SpcRule = "R1" | "R2" | "R3" | "R5" | "OOS";

export const RULE_TEXT: Record<SpcRule, string> = {
  OOS: "Out of spec (USL/LSL)",
  R1: "1 point beyond 3σ",
  R2: "9 points in a row on one side of CL",
  R3: "6 points in a row steadily up or down",
  R5: "2 of 3 points beyond 2σ, same side",
};

export interface QmsConfig {
  baselinePoints: number;
  rules: Record<SpcRule, boolean>;
  /** Hold the lot on an OOS result. */
  holdOnOos: boolean;
  /** Inhibit (HOLD) the equipment after this many consecutive OOS lots; 0 = off. */
  inhibitAfterOosLots: number;
}

export const DEFAULT_QMS_CONFIG: QmsConfig = {
  baselinePoints: 20,
  rules: { OOS: true, R1: true, R2: true, R3: true, R5: true },
  holdOnOos: true,
  inhibitAfterOosLots: 3,
};

export interface SpcPoint {
  ts: number;
  value: number;
  lotId: string;
  waferId: string;
  chamberId: string;
  runId: string;
  recipeId: string;
  fdcStatus: string | null;
  violations: SpcRule[];
}

interface Chart {
  key: string;
  eqpId: string;
  item: string;
  name: string;
  unit: string;
  target: number;
  usl: number | null;
  lsl: number | null;
  specSource: "MASTER" | "MANUAL";
  cl: number | null;
  ucl: number | null;
  lcl: number | null;
  sigma: number | null;
  limitSource: "LEARNING" | "AUTO" | "MANUAL";
  points: SpcPoint[];
  ooc: number;
  oos: number;
}

export interface QmsLot {
  lotId: string;
  eqpId: string;
  recipeId: string;
  status: "IN_PROGRESS" | "PASSED" | "HOLD" | "RELEASED" | "SCRAPPED" | "REWORK";
  measured: number;
  oos: number;
  ooc: number;
  reason: string;
  firstTs: number;
  lastTs: number;
  dispositionBy: string | null;
}

const MAX_POINTS = 400;
const MAX_LOTS = 800;

export class QmsSystem implements FabSystem {
  readonly id = "QMS" as const;
  config: QmsConfig = structuredClone(DEFAULT_QMS_CONFIG);
  private master = new MasterData();
  private charts = new Map<string, Chart>();
  private lots = new Map<string, QmsLot>();
  private lotOrder: string[] = [];
  private fdcByRun = new Map<string, string>();
  private consecutiveOos = new Map<string, number>();
  private specOverrides = new Map<string, { target: number; usl: number | null; lsl: number | null }>();

  constructor(private bus: MessageBus) {
    bus.subscribe("QMS", "eqp/+/info", (m) => this.master.apply((m as Envelope<EquipmentInfoPayload>).payload), "Master data (specs)");
    bus.subscribe("QMS", "eqp/+/metrology", (m) => this.onMetrology(m as Envelope<MetrologyPayload>), "Metrology results");
    bus.subscribe("QMS", "eqp/+/event", (m) => this.onEvent(m as Envelope<EventPayload>), "Lot end (ERD)");
    bus.subscribe("QMS", topics.fdcRun, (m) => this.onFdcRun(m as Envelope<FdcRunPayload>), "FDC run verdicts");
  }

  tick() {}

  reset() {
    this.charts.clear();
    this.lots.clear();
    this.lotOrder = [];
    this.fdcByRun.clear();
    this.consecutiveOos.clear();
  }

  private onFdcRun(m: Envelope<FdcRunPayload>) {
    this.fdcByRun.set(m.payload.runId, m.payload.status);
    if (this.fdcByRun.size > 5000) this.fdcByRun.delete(this.fdcByRun.keys().next().value!);
  }

  private chart(eqpId: string, item: MetrologyPayload["items"][number]): Chart {
    const key = `${eqpId}|${item.key}`;
    let c = this.charts.get(key);
    if (!c) {
      const o = this.specOverrides.get(key);
      c = {
        key,
        eqpId,
        item: item.key,
        name: item.name,
        unit: item.unit,
        target: o?.target ?? item.target,
        usl: o ? o.usl : (item.usl ?? null),
        lsl: o ? o.lsl : (item.lsl ?? null),
        specSource: o ? "MANUAL" : "MASTER",
        cl: null,
        ucl: null,
        lcl: null,
        sigma: null,
        limitSource: "LEARNING",
        points: [],
        ooc: 0,
        oos: 0,
      };
      this.charts.set(key, c);
    }
    return c;
  }

  private lot(m: MetrologyPayload, ts: number): QmsLot {
    let lot = this.lots.get(m.lotId);
    if (!lot) {
      lot = {
        lotId: m.lotId,
        eqpId: m.eqpId,
        recipeId: m.recipeId,
        status: "IN_PROGRESS",
        measured: 0,
        oos: 0,
        ooc: 0,
        reason: "",
        firstTs: ts,
        lastTs: ts,
        dispositionBy: null,
      };
      this.lots.set(m.lotId, lot);
      this.lotOrder.push(m.lotId);
      if (this.lotOrder.length > MAX_LOTS) this.lots.delete(this.lotOrder.shift()!);
    }
    return lot;
  }

  private onMetrology(msg: Envelope<MetrologyPayload>) {
    const m = msg.payload;
    const lot = this.lot(m, msg.ts);
    lot.measured++;
    lot.lastTs = msg.ts;
    for (const item of m.items) {
      const c = this.chart(m.eqpId, item);
      const point: SpcPoint = {
        ts: msg.ts,
        value: item.value,
        lotId: m.lotId,
        waferId: m.waferId,
        chamberId: m.chamberId,
        runId: m.runId,
        recipeId: m.recipeId,
        fdcStatus: this.fdcByRun.get(m.runId) ?? null,
        violations: [],
      };
      pushRing(c.points, point, MAX_POINTS);
      if (c.limitSource === "LEARNING" && c.points.length >= this.config.baselinePoints) this.learn(c);
      point.violations = this.check(c);
      if (!point.violations.length) continue;
      const isOos = point.violations.includes("OOS");
      if (isOos) {
        c.oos++;
        lot.oos++;
      } else {
        c.ooc++;
        lot.ooc++;
      }
      const severity: Severity = isOos ? "MAJOR" : point.violations.includes("R1") ? "WARNING" : "INFO";
      const rules = point.violations.map((r) => `${r} ${RULE_TEXT[r]}`).join("; ");
      this.alarm(
        {
          eqpId: m.eqpId,
          code: isOos ? `QMS-OOS-${item.key.toUpperCase()}` : `QMS-OOC-${item.key.toUpperCase()}`,
          text: `${item.name} ${round(item.value, 4)}${item.unit ? " " + item.unit : ""} on ${m.waferId} (${m.chamberId}): ${rules}`,
          severity,
          set: true,
          context: { lotId: m.lotId, waferId: m.waferId, chamberId: m.chamberId, runId: m.runId, item: item.key },
        },
        msg.ts,
      );
      if (isOos && this.config.holdOnOos && lot.status !== "HOLD") this.setLot(lot, "HOLD", `OOS ${item.name}`, "QMS", msg.ts);
    }
  }

  private onEvent(msg: Envelope<EventPayload>) {
    const e = msg.payload;
    if (e.name !== "LOT_END") return;
    const lotId = String(e.reports[0]?.values.LotID ?? "");
    const lot = this.lots.get(lotId);
    if (lot?.status === "IN_PROGRESS") {
      lot.status = "PASSED";
      lot.lastTs = msg.ts;
    }
    const oosLot = lot ? lot.oos > 0 : false;
    const n = oosLot ? (this.consecutiveOos.get(e.eqpId) ?? 0) + 1 : 0;
    this.consecutiveOos.set(e.eqpId, n);
    const limit = this.config.inhibitAfterOosLots;
    if (limit > 0 && n >= limit) {
      this.consecutiveOos.set(e.eqpId, 0);
      const cmd: CommandPayload = {
        eqpId: e.eqpId,
        action: "HOLD",
        args: { reason: `QMS inhibit: ${n} consecutive OOS lots` },
        origin: "HOST",
        requestedBy: "QMS",
      };
      this.bus.publish(topics.command(e.eqpId), "command", "QMS", cmd, msg.ts);
      this.alarm({ eqpId: e.eqpId, code: "QMS-EQP-INHIBIT", text: `Equipment inhibited after ${n} consecutive OOS lots`, severity: "CRITICAL", set: true }, msg.ts);
    }
  }

  private learn(c: Chart) {
    const base = c.points.slice(-this.config.baselinePoints).map((p) => p.value);
    const cl = mean(base);
    const mr = mean(base.slice(1).map((v, i) => Math.abs(v - base[i])));
    const sigma = Math.max(mr / 1.128, 1e-9);
    c.cl = cl;
    c.sigma = sigma;
    c.ucl = cl + 3 * sigma;
    c.lcl = cl - 3 * sigma;
    c.limitSource = "AUTO";
  }

  private check(c: Chart): SpcRule[] {
    const out: SpcRule[] = [];
    const r = this.config.rules;
    const pts = c.points;
    const v = pts[pts.length - 1].value;
    if (r.OOS && ((c.usl !== null && v > c.usl) || (c.lsl !== null && v < c.lsl))) out.push("OOS");
    if (c.cl === null || c.sigma === null || c.ucl === null || c.lcl === null) return out;
    const cl = c.cl;
    const s = c.sigma;
    if (r.R1 && (v > c.ucl || v < c.lcl)) out.push("R1");
    const last = (n: number) => pts.slice(-n).map((p) => p.value);
    if (r.R2 && pts.length >= 9) {
      const xs = last(9);
      if (xs.every((x) => x > cl) || xs.every((x) => x < cl)) out.push("R2");
    }
    if (r.R3 && pts.length >= 6) {
      const xs = last(6);
      const d = xs.slice(1).map((x, i) => x - xs[i]);
      if (d.every((x) => x > 0) || d.every((x) => x < 0)) out.push("R3");
    }
    if (r.R5 && pts.length >= 3) {
      const xs = last(3);
      const hi = xs.filter((x) => x > cl + 2 * s).length;
      const lo = xs.filter((x) => x < cl - 2 * s).length;
      if ((hi >= 2 && v > cl + 2 * s) || (lo >= 2 && v < cl - 2 * s)) out.push("R5");
    }
    return out;
  }

  private alarm(payload: SystemAlarmPayload, ts: number) {
    this.bus.publish(topics.qmsAlarm, "qms.alarm", "QMS", payload, ts);
  }

  private setLot(lot: QmsLot, status: QmsLot["status"], reason: string, by: string, ts: number) {
    lot.status = status;
    lot.reason = reason;
    lot.dispositionBy = by;
    lot.lastTs = ts;
    if (status === "HOLD" || status === "RELEASED" || status === "SCRAPPED" || status === "REWORK") {
      const payload: QmsLotPayload = { lotId: lot.lotId, eqpId: lot.eqpId, status, reason };
      this.bus.publish(topics.qmsLot, "qms.lot", "QMS", payload, ts);
    }
  }

  // ------------------------------------------------------------- API

  private capability(c: Chart) {
    const xs = c.points.slice(-60).map((p) => p.value);
    if (xs.length < 5) return { n: xs.length, mean: null, std: null, cp: null, cpk: null };
    const m = mean(xs);
    const s = std(xs, m);
    const cp = c.usl !== null && c.lsl !== null && s > 0 ? (c.usl - c.lsl) / (6 * s) : null;
    const cpu = c.usl !== null && s > 0 ? (c.usl - m) / (3 * s) : null;
    const cpl = c.lsl !== null && s > 0 ? (m - c.lsl) / (3 * s) : null;
    const cpk = cpu !== null && cpl !== null ? Math.min(cpu, cpl) : (cpu ?? cpl);
    return { n: xs.length, mean: round(m, 5), std: round(s, 5), cp: cp === null ? null : round(cp, 3), cpk: cpk === null ? null : round(cpk, 3) };
  }

  listCharts(filter: { eqpId?: string }) {
    return [...this.charts.values()]
      .filter((c) => matchesFilter(c.eqpId, filter.eqpId))
      .map((c) => {
        const last = c.points[c.points.length - 1];
        return {
          key: c.key,
          eqpId: c.eqpId,
          type: this.master.get(c.eqpId)?.type ?? null,
          item: c.item,
          name: c.name,
          unit: c.unit,
          target: c.target,
          usl: c.usl,
          lsl: c.lsl,
          cl: c.cl,
          ucl: c.ucl,
          lcl: c.lcl,
          limitSource: c.limitSource,
          points: c.points.length,
          ooc: c.ooc,
          oos: c.oos,
          last: last ? { value: last.value, ts: last.ts, violations: last.violations } : null,
          ...this.capability(c),
        };
      });
  }

  getChart(key: string, limit = 200) {
    const c = this.charts.get(key);
    if (!c) return undefined;
    return {
      key: c.key,
      eqpId: c.eqpId,
      item: c.item,
      name: c.name,
      unit: c.unit,
      target: c.target,
      usl: c.usl,
      lsl: c.lsl,
      specSource: c.specSource,
      cl: c.cl,
      ucl: c.ucl,
      lcl: c.lcl,
      sigma: c.sigma,
      limitSource: c.limitSource,
      points: c.points.slice(-limit),
      ...this.capability(c),
    };
  }

  updateChart(key: string, patch: { target?: number; usl?: number | null; lsl?: number | null; cl?: number; ucl?: number; lcl?: number; relearn?: boolean }) {
    const c = this.charts.get(key);
    if (!c) return undefined;
    if (patch.target !== undefined || patch.usl !== undefined || patch.lsl !== undefined) {
      if (patch.target !== undefined) c.target = patch.target;
      if (patch.usl !== undefined) c.usl = patch.usl;
      if (patch.lsl !== undefined) c.lsl = patch.lsl;
      if (c.usl !== null && c.lsl !== null && c.usl <= c.lsl) throw new Error("USL must be greater than LSL");
      c.specSource = "MANUAL";
      this.specOverrides.set(key, { target: c.target, usl: c.usl, lsl: c.lsl });
    }
    if (patch.ucl !== undefined && patch.lcl !== undefined) {
      if (patch.ucl <= patch.lcl) throw new Error("UCL must be greater than LCL");
      c.ucl = patch.ucl;
      c.lcl = patch.lcl;
      c.cl = patch.cl ?? (patch.ucl + patch.lcl) / 2;
      c.sigma = (patch.ucl - patch.lcl) / 6;
      c.limitSource = "MANUAL";
    }
    if (patch.relearn) {
      c.limitSource = "LEARNING";
      c.cl = c.ucl = c.lcl = c.sigma = null;
      if (c.points.length >= this.config.baselinePoints) this.learn(c);
    }
    return this.getChart(key);
  }

  listLots(filter: { eqpId?: string; status?: string; limit?: number }) {
    const out: QmsLot[] = [];
    for (let i = this.lotOrder.length - 1; i >= 0 && out.length < (filter.limit ?? 200); i--) {
      const lot = this.lots.get(this.lotOrder[i]);
      if (!lot || !matchesFilter(lot.eqpId, filter.eqpId) || !matchesFilter(lot.status, filter.status)) continue;
      out.push(lot);
    }
    return out;
  }

  disposition(lotId: string, status: "RELEASED" | "SCRAPPED" | "REWORK", by: string, ts: number, note = "") {
    const lot = this.lots.get(lotId);
    if (!lot) throw new Error(`Unknown lot ${lotId}`);
    if (lot.status !== "HOLD") throw new Error(`Lot ${lotId} is ${lot.status}, only HOLD lots can be dispositioned`);
    this.setLot(lot, status, note || `${status} by ${by}`, by, ts);
    return lot;
  }

  summary() {
    const lots = [...this.lots.values()];
    return {
      charts: this.charts.size,
      points: [...this.charts.values()].reduce((s, c) => s + c.points.length, 0),
      ooc: [...this.charts.values()].reduce((s, c) => s + c.ooc, 0),
      oos: [...this.charts.values()].reduce((s, c) => s + c.oos, 0),
      lots: {
        total: lots.length,
        hold: lots.filter((l) => l.status === "HOLD").length,
        passed: lots.filter((l) => l.status === "PASSED").length,
        released: lots.filter((l) => l.status === "RELEASED").length,
        scrapped: lots.filter((l) => l.status === "SCRAPPED").length,
        rework: lots.filter((l) => l.status === "REWORK").length,
      },
    };
  }

  setConfig(patch: Partial<QmsConfig>) {
    this.config = { ...this.config, ...patch, rules: { ...this.config.rules, ...(patch.rules ?? {}) } };
    return this.config;
  }

  specOverridesList() {
    return Object.fromEntries(this.specOverrides);
  }

  loadSpecOverrides(o: Record<string, { target: number; usl: number | null; lsl: number | null }>) {
    this.specOverrides = new Map(Object.entries(o));
  }
}
