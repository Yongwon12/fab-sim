import type {
  CommandPayload,
  Envelope,
  EquipmentInfoPayload,
  EventPayload,
  FaultClass,
  FdcAlarmPayload,
  FdcRunPayload,
  Severity,
  TracePayload,
} from "../../shared/types";
import { SEVERITY_RANK } from "../../shared/types";
import { topics } from "../../shared/topics";
import type { MessageBus } from "../bus/message-bus";
import type { FabSystem } from "./common";
import { MasterData, matchesFilter, mean, pushRing, residualStd, round, std } from "./common";

// FDC — Fault Detection & Classification.
//  1. Collects trace per run (context comes with every sample, so FDC keeps
//     working even if the event reports are switched off).
//  2. At each step end computes indicators (mean/std/min/max per parameter).
//  3. Learns limits per chamber/recipe/step/parameter/indicator from the first
//     N runs, then checks every new run against them.
//  4. Classifies a violation (shift, drift, spike, noise, stuck), raises an FDC
//     alarm and, depending on the interlock policy, holds the equipment.
//  5. Real-time check: a sample leaving the setpoint band after it settled.

export type IndicatorStat = "mean" | "std" | "min" | "max";
const STATS: IndicatorStat[] = ["mean", "std", "min", "max"];

export interface FdcConfig {
  baselineRuns: number;
  sigmaK: number;
  /** Minimum limit half-width as a fraction of the parameter tolerance (mean/min/max). */
  minWidthFactor: number;
  /** Seconds ignored at the start of every step (transients). */
  trimSec: number;
  /** A parameter's step window starts once |value - setpoint| <= settleFactor × tolerance ... */
  settleFactor: number;
  /** ... or this many seconds into the step, whichever comes first. */
  settleMaxSec: number;
  /** Fewer settled samples than this in a step: no indicators for it (std needs 5). */
  minSamples: number;
  realtime: boolean;
  /** Real-time band: setpoint ± factor × tolerance. */
  realtimeFactor: number;
  interlock: "OFF" | "CRITICAL" | "ALL";
  /** Beyond center ± factor × half-width a violation is CRITICAL. */
  criticalFactor: number;
  driftRuns: number;
}

export const DEFAULT_FDC_CONFIG: FdcConfig = {
  baselineRuns: 5,
  sigmaK: 3.5,
  minWidthFactor: 0.5,
  trimSec: 2,
  settleFactor: 0.3,
  settleMaxSec: 20,
  minSamples: 3,
  realtime: true,
  realtimeFactor: 3,
  interlock: "CRITICAL",
  criticalFactor: 2,
  driftRuns: 6,
};

interface Sample {
  ts: number;
  stepNo: number;
  paused: boolean;
  values: Record<string, number>;
  setpoints: Record<string, number>;
}

interface StepInfo {
  stepNo: number;
  stepName: string;
  startTs: number;
  endTs: number;
}

export interface Indicator {
  stepNo: number;
  stepName: string;
  param: string;
  stat: IndicatorStat;
  value: number;
  center: number | null;
  lcl: number | null;
  ucl: number | null;
  violated: boolean;
  modelKey: string;
}

export interface FdcFault extends FdcAlarmPayload {
  id: number;
  ts: number;
}

export type RunStatus = "RUNNING" | "OK" | "WARN" | "FAULT" | "LEARNING" | "ABORTED";

interface FdcRun {
  runId: string;
  eqpId: string;
  chamberId: string;
  lotId: string;
  waferIds: string[];
  recipeId: string;
  startTs: number;
  endTs: number | null;
  samples: Sample[];
  steps: StepInfo[];
  indicators: Indicator[];
  faults: FdcFault[];
  status: RunStatus;
  learning: boolean;
  interlocked: boolean;
  rtBad: Record<string, number>;
  rtSettled: Record<string, boolean>;
  rtFlagged: Set<string>;
  reported: Set<string>;
  paused: boolean;
  /** Steps disturbed by a pause are not judged (the wafer is flagged instead). */
  interrupted: Set<number>;
}

export interface LimitModel {
  key: string;
  eqpId: string;
  chamberId: string;
  recipeId: string;
  stepNo: number;
  stepName: string;
  param: string;
  stat: IndicatorStat;
  state: "LEARNING" | "ACTIVE" | "DISABLED";
  source: "AUTO" | "MANUAL";
  center: number;
  sigma: number;
  lcl: number;
  ucl: number;
  n: number;
  /** Typical samples per window during learning (sizes the std floor). */
  samples: number;
  learnSamples: number[];
  learn: number[];
  history: Array<{ runId: string; ts: number; value: number; violated: boolean }>;
}

const RUNS_PER_CHAMBER = 40;
const MAX_FAULTS = 1500;
const MODEL_HISTORY = 150;

export class FdcSystem implements FabSystem {
  readonly id = "FDC" as const;
  config: FdcConfig = { ...DEFAULT_FDC_CONFIG };
  private master = new MasterData();
  private runs = new Map<string, FdcRun>();
  private runOrder: string[] = [];
  private activeByChamber = new Map<string, string>();
  private models = new Map<string, LimitModel>();
  private faults: FdcFault[] = [];
  private faultSeq = 0;
  private recipeSig = new Map<string, string>();
  private counters = { runs: 0, faults: 0, interlocks: 0, samples: 0 };

  constructor(private bus: MessageBus) {
    bus.subscribe("FDC", "eqp/+/info", (m) => this.onInfo(m.payload as EquipmentInfoPayload), "Master data");
    bus.subscribe("FDC", "eqp/+/trace/+", (m) => this.onTrace(m as Envelope<TracePayload>), "Trace data");
    bus.subscribe("FDC", "eqp/+/event", (m) => this.onEvent(m as Envelope<EventPayload>), "Run context (ERD)");
  }

  tick() {}

  reset() {
    this.runs.clear();
    this.runOrder = [];
    this.activeByChamber.clear();
    this.models.clear();
    this.faults = [];
    this.counters = { runs: 0, faults: 0, interlocks: 0, samples: 0 };
  }

  // ------------------------------------------------------------ inputs

  private onInfo(info: EquipmentInfoPayload) {
    this.master.apply(info);
    for (const r of info.recipes ?? []) {
      const key = `${info.eqpId}|${r.id}`;
      const sig = r.steps.map((s) => `${s.name}:${s.duration}`).join(",");
      const prev = this.recipeSig.get(key);
      this.recipeSig.set(key, sig);
      if (prev !== undefined && prev !== sig) this.relearn({ eqpId: info.eqpId, recipeId: r.id });
    }
  }

  private onTrace(msg: Envelope<TracePayload>) {
    const t = msg.payload;
    this.counters.samples++;
    const chKey = `${t.eqpId}|${t.chamberId}`;
    const activeId = this.activeByChamber.get(chKey);
    const ctx = t.context;
    if (!ctx) {
      if (activeId) this.finalize(activeId, msg.ts, false);
      return;
    }
    if (activeId && activeId !== ctx.runId) this.finalize(activeId, msg.ts, false);
    let run = this.runs.get(ctx.runId);
    if (!run) {
      run = this.openRun(t, msg.ts);
    }
    if (run.endTs !== null) return;
    const last = run.steps[run.steps.length - 1];
    if (!last || last.stepNo !== ctx.stepNo) {
      if (last) this.closeStep(run, last, msg.ts);
      run.steps.push({ stepNo: ctx.stepNo, stepName: ctx.stepName, startTs: msg.ts, endTs: msg.ts });
      run.rtSettled = {};
      run.rtBad = {};
    }
    const step = run.steps[run.steps.length - 1];
    step.endTs = msg.ts;
    run.samples.push({ ts: msg.ts, stepNo: ctx.stepNo, paused: run.paused, values: t.values, setpoints: t.setpoints });
    if (run.paused) run.interrupted.add(ctx.stepNo);
    else if (this.config.realtime) this.realtimeCheck(run, step, t, msg.ts);
  }

  private onEvent(msg: Envelope<EventPayload>) {
    const e = msg.payload;
    const runId = String(e.reports[0]?.values.RunID ?? "");
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return;
    switch (e.name) {
      case "PROCESS_PAUSED":
        run.paused = true;
        break;
      case "PROCESS_RESUMED":
        run.paused = false;
        run.rtSettled = {};
        run.rtBad = {};
        break;
      case "PROCESS_END":
      case "PROCESS_ABORTED":
        this.finalize(runId, msg.ts, e.name === "PROCESS_ABORTED");
        break;
    }
  }

  private openRun(t: TracePayload, ts: number): FdcRun {
    const ctx = t.context!;
    const run: FdcRun = {
      runId: ctx.runId,
      eqpId: t.eqpId,
      chamberId: t.chamberId,
      lotId: ctx.lotId,
      waferIds: ctx.waferIds,
      recipeId: ctx.recipeId,
      startTs: ts,
      endTs: null,
      samples: [],
      steps: [],
      indicators: [],
      faults: [],
      status: "RUNNING",
      learning: false,
      interlocked: false,
      rtBad: {},
      rtSettled: {},
      rtFlagged: new Set(),
      reported: new Set(),
      paused: false,
      interrupted: new Set(),
    };
    this.runs.set(run.runId, run);
    this.runOrder.push(run.runId);
    this.activeByChamber.set(`${t.eqpId}|${t.chamberId}`, run.runId);
    this.trimRuns(t.eqpId, t.chamberId);
    return run;
  }

  private trimRuns(eqpId: string, chamberId: string) {
    const mine = this.runOrder.filter((id) => {
      const r = this.runs.get(id);
      return r && r.eqpId === eqpId && r.chamberId === chamberId;
    });
    if (mine.length <= RUNS_PER_CHAMBER) return;
    const drop = new Set(mine.slice(0, mine.length - RUNS_PER_CHAMBER));
    for (const id of drop) this.runs.delete(id);
    this.runOrder = this.runOrder.filter((id) => !drop.has(id));
  }

  // --------------------------------------------------------- real-time

  private realtimeCheck(run: FdcRun, step: StepInfo, t: TracePayload, ts: number) {
    if (ts - step.startTs < this.config.trimSec * 1000) return;
    for (const [param, value] of Object.entries(t.values)) {
      const sp = t.setpoints[param];
      if (sp === undefined) continue;
      const tol = this.master.tolerance(t.eqpId, param);
      if (!tol) continue;
      const band = this.config.realtimeFactor * tol;
      const out = Math.abs(value - sp) > band;
      if (!out) {
        run.rtSettled[param] = true;
        run.rtBad[param] = 0;
        continue;
      }
      if (!run.rtSettled[param]) continue;
      run.rtBad[param] = (run.rtBad[param] ?? 0) + 1;
      if (run.rtBad[param] >= 2 && !run.rtFlagged.has(param)) {
        run.rtFlagged.add(param);
        this.raise(run, {
          stepNo: step.stepNo,
          stepName: step.stepName,
          param,
          indicator: "sample",
          value,
          lcl: sp - band,
          ucl: sp + band,
          faultClass: "OUT_OF_SPEC",
          severity: "MAJOR",
          message: `${param} left setpoint band in step ${step.stepNo} ${step.stepName}: ${round(value, 3)} vs SP ${sp} ± ${round(band, 3)}`,
        }, ts);
      }
    }
  }

  // ------------------------------------------------------------ steps

  private closeStep(run: FdcRun, step: StepInfo, ts: number) {
    const all = run.samples.filter((s) => s.stepNo === step.stepNo);
    if (!all.length || run.interrupted.has(step.stepNo)) return;
    const c = this.config;
    const params = Object.keys(all[0].values);
    const violations: Indicator[] = [];
    for (const param of params) {
      // Step window: skip the trim, then wait until the value has settled on
      // its setpoint so that transients do not look like faults.
      const tol = this.master.tolerance(run.eqpId, param);
      const startIdx = all.findIndex((s) => {
        const t = s.ts - step.startTs;
        if (t < c.trimSec * 1000) return false;
        if (!tol) return true;
        return t >= c.settleMaxSec * 1000 || Math.abs(s.values[param] - (s.setpoints[param] ?? s.values[param])) <= c.settleFactor * tol;
      });
      if (startIdx < 0) continue;
      const window = all.slice(startIdx).filter((s) => Number.isFinite(s.values[param]));
      if (window.length < c.minSamples) continue;
      const first = window[0];
      const inBand = !tol || Math.abs(first.values[param] - (first.setpoints[param] ?? first.values[param])) <= c.settleFactor * tol;
      if (!inBand && rampTravel(window, param) > tol) {
        // Still ramping when settleMaxSec ran out (furnace ramp steps): no
        // stable level to judge. A stable offset (a real shift) is kept.
        continue;
      }
      const xs = window.map((s) => s.values[param]);
      const m = mean(xs);
      const values: Partial<Record<IndicatorStat, number>> = { mean: m };
      // A parameter parked at zero (gas off, RF off) is only watched for its
      // level; its min/max/noise are clipped sensor noise.
      const active = window.some((s) => (s.setpoints[param] ?? 0) !== 0);
      if (active) {
        values.min = Math.min(...xs);
        values.max = Math.max(...xs);
        // Noise is judged without the first two settled samples: the tail of
        // the transient is still in them and would read as noise.
        const quiet = window.slice(2);
        if (quiet.length >= 5) values.std = residualStd(quiet.map((s) => s.ts), quiet.map((s) => s.values[param]));
      }
      for (const stat of STATS) {
        const v = values[stat];
        if (v === undefined) continue;
        const ind = this.evaluate(run, step, param, stat, v, xs.length, ts);
        run.indicators.push(ind);
        if (ind.violated) violations.push(ind);
      }
    }
    // One alarm per parameter per step, most informative indicator first.
    const byParam = new Map<string, Indicator[]>();
    for (const v of violations) byParam.set(v.param, [...(byParam.get(v.param) ?? []), v]);
    for (const [param, list] of byParam) {
      const pick = list.find((i) => i.stat === "mean") ?? list.find((i) => i.stat === "std") ?? list[0];
      const model = this.models.get(pick.modelKey)!;
      let faultClass = this.classify(pick, model);
      if (faultClass === "SPIKE") {
        // min/max out while the mean has walked most of the way too: the whole
        // level moved, so classify on the mean's history instead.
        const meanInd = run.indicators.find((i) => i.stepNo === step.stepNo && i.param === param && i.stat === "mean");
        const meanModel = meanInd && this.models.get(meanInd.modelKey);
        if (meanInd && meanModel?.state === "ACTIVE") {
          const hw = (meanModel.ucl - meanModel.lcl) / 2;
          const dir = Math.sign(pick.value - model.center);
          if ((meanInd.value - meanModel.center) * dir > 0.5 * hw) faultClass = this.classify(meanInd, meanModel);
        }
      }
      const hw = Math.max(1e-9, (model.ucl - model.lcl) / 2);
      const dist = Math.abs(pick.value - model.center) / hw;
      let severity: Severity = dist > this.config.criticalFactor || faultClass === "STUCK" ? "CRITICAL" : "MAJOR";
      // Sample std is right-skewed: only gross noise (3x the learned level) is critical.
      if (faultClass === "NOISE" && pick.value < 3 * model.center) severity = "MAJOR";
      if (faultClass === "DRIFT" && severity === "MAJOR") severity = "WARNING";
      const dedupe = `${param}|${faultClass}`;
      if (run.reported.has(dedupe)) continue;
      run.reported.add(dedupe);
      this.raise(run, {
        stepNo: step.stepNo,
        stepName: step.stepName,
        param,
        indicator: pick.stat,
        value: pick.value,
        lcl: model.lcl,
        ucl: model.ucl,
        faultClass,
        severity,
        message: `${faultClass} on ${param} (${pick.stat}) step ${step.stepNo} ${step.stepName}: ${round(pick.value, 3)} outside [${round(model.lcl, 3)}, ${round(model.ucl, 3)}]`,
      }, ts);
    }
  }

  private evaluate(run: FdcRun, step: StepInfo, param: string, stat: IndicatorStat, value: number, samples: number, ts: number): Indicator {
    const key = `${run.eqpId}|${run.chamberId}|${run.recipeId}|${step.stepNo}|${param}|${stat}`;
    let model = this.models.get(key);
    if (!model) {
      model = {
        key,
        eqpId: run.eqpId,
        chamberId: run.chamberId,
        recipeId: run.recipeId,
        stepNo: step.stepNo,
        stepName: step.stepName,
        param,
        stat,
        state: "LEARNING",
        source: "AUTO",
        center: NaN,
        sigma: NaN,
        lcl: NaN,
        ucl: NaN,
        n: 0,
        samples: 0,
        learnSamples: [],
        learn: [],
        history: [],
      };
      this.models.set(key, model);
    }
    let violated = false;
    if (model.state === "LEARNING") {
      model.learn.push(value);
      model.learnSamples.push(samples);
      run.learning = true;
      if (model.learn.length >= this.config.baselineRuns) this.fit(model);
    } else if (model.state === "ACTIVE") {
      violated = value < model.lcl || value > model.ucl;
    }
    pushRing(model.history, { runId: run.runId, ts, value: round(value, 5), violated }, MODEL_HISTORY);
    const active = model.state === "ACTIVE";
    return {
      stepNo: step.stepNo,
      stepName: step.stepName,
      param,
      stat,
      value: round(value, 5),
      center: active ? round(model.center, 5) : null,
      lcl: active ? round(model.lcl, 5) : null,
      ucl: active ? round(model.ucl, 5) : null,
      violated,
      modelKey: key,
    };
  }

  private fit(model: LimitModel) {
    const c = mean(model.learn);
    const s = std(model.learn, c);
    const tol = this.master.tolerance(model.eqpId, model.param);
    const n = Math.max(2, Math.min(...model.learnSamples));
    // The std of n samples scatters by about std / sqrt(2(n - 1)); five
    // baseline runs cannot see that, so it sets the floor together with the
    // parameter tolerance.
    const floor =
      model.stat === "std"
        ? Math.max(((this.config.sigmaK + 1) * Math.abs(c)) / Math.sqrt(2 * (n - 1)), 0.2 * tol, 1e-6)
        : model.stat === "mean"
          ? Math.max(this.config.minWidthFactor * tol, 1e-6)
          : Math.max(1.5 * this.config.minWidthFactor * tol, 1e-6);
    const hw = Math.max(this.config.sigmaK * s, floor);
    model.center = c;
    model.sigma = s;
    model.lcl = model.stat === "std" ? Math.max(0, c - hw) : c - hw;
    model.ucl = c + hw;
    model.n = model.learn.length;
    model.samples = Math.round(mean(model.learnSamples));
    model.state = "ACTIVE";
    model.source = "AUTO";
  }

  private classify(ind: Indicator, model: LimitModel): FaultClass {
    if (ind.stat === "std") return ind.value > model.ucl ? "NOISE" : "STUCK";
    if (ind.stat === "min" || ind.stat === "max") return "SPIKE";
    // Drift: a gradual, mostly one-directional walk over recent runs. A shift
    // is one jump, so no single step may carry most of the travel.
    const recent = model.history.slice(-this.config.driftRuns).map((h) => h.value);
    if (recent.length >= 4) {
      const diffs = recent.slice(1).map((v, i) => v - recent[i]);
      const travel = recent[recent.length - 1] - recent[0];
      const along = diffs.filter((d) => Math.sign(d) === Math.sign(travel)).length / diffs.length;
      const biggest = Math.max(...diffs.map(Math.abs));
      const hw = (model.ucl - model.lcl) / 2;
      if (along >= 0.75 && Math.abs(travel) > 0.5 * hw && biggest < 0.5 * Math.abs(travel)) return "DRIFT";
    }
    return "SHIFT";
  }

  private raise(
    run: FdcRun,
    f: Pick<FdcAlarmPayload, "stepNo" | "stepName" | "param" | "indicator" | "value" | "lcl" | "ucl" | "faultClass" | "severity" | "message">,
    ts: number,
  ) {
    const p = this.config.interlock;
    const interlock = !run.interlocked && (p === "ALL" || (p === "CRITICAL" && f.severity === "CRITICAL"));
    const payload: FdcAlarmPayload = {
      eqpId: run.eqpId,
      chamberId: run.chamberId,
      runId: run.runId,
      lotId: run.lotId,
      waferIds: run.waferIds,
      recipeId: run.recipeId,
      ...f,
      value: round(f.value, 5),
      lcl: round(f.lcl, 5),
      ucl: round(f.ucl, 5),
      interlock,
    };
    const fault: FdcFault = { ...payload, id: ++this.faultSeq, ts };
    run.faults.push(fault);
    pushRing(this.faults, fault, MAX_FAULTS);
    this.counters.faults++;
    this.bus.publish(topics.fdcAlarm, "fdc.alarm", "FDC", payload, ts);
    if (interlock) {
      run.interlocked = true;
      this.counters.interlocks++;
      const cmd: CommandPayload = {
        eqpId: run.eqpId,
        action: "HOLD",
        args: { reason: `FDC interlock: ${f.faultClass} ${f.param} (${run.chamberId} ${run.runId})` },
        origin: "HOST",
        requestedBy: "FDC",
      };
      this.bus.publish(topics.command(run.eqpId), "command", "FDC", cmd, ts);
    }
  }

  private finalize(runId: string, ts: number, aborted: boolean) {
    const run = this.runs.get(runId);
    if (!run || run.endTs !== null) return;
    const last = run.steps[run.steps.length - 1];
    if (last && !aborted) this.closeStep(run, last, ts);
    run.endTs = ts;
    const key = `${run.eqpId}|${run.chamberId}`;
    if (this.activeByChamber.get(key) === runId) this.activeByChamber.delete(key);
    const worst = run.faults.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), -1);
    run.status = aborted
      ? "ABORTED"
      : worst >= SEVERITY_RANK.MAJOR
        ? "FAULT"
        : worst >= 0
          ? "WARN"
          : run.interrupted.size
            ? "WARN"
            : run.learning
              ? "LEARNING"
              : "OK";
    this.counters.runs++;
    const payload: FdcRunPayload = {
      eqpId: run.eqpId,
      chamberId: run.chamberId,
      runId: run.runId,
      lotId: run.lotId,
      waferIds: run.waferIds,
      recipeId: run.recipeId,
      status: run.status as FdcRunPayload["status"],
      faultCount: run.faults.length,
    };
    this.bus.publish(topics.fdcRun, "fdc.run", "FDC", payload, ts);
  }

  // ------------------------------------------------------------- API

  summary() {
    const models = [...this.models.values()];
    const byEqp = this.master.all().map((info) => {
      const runs = [...this.runs.values()].filter((r) => r.eqpId === info.eqpId && r.endTs !== null);
      const recent = runs.slice(-20);
      return {
        eqpId: info.eqpId,
        type: info.type,
        runs: runs.length,
        faultRuns: recent.filter((r) => r.status === "FAULT" || r.status === "WARN").length,
        recentRuns: recent.length,
        lastStatus: runs[runs.length - 1]?.status ?? null,
        learning: models.filter((m) => m.eqpId === info.eqpId && m.state === "LEARNING").length,
        active: models.filter((m) => m.eqpId === info.eqpId && m.state === "ACTIVE").length,
      };
    });
    return {
      counters: { ...this.counters },
      models: {
        total: models.length,
        learning: models.filter((m) => m.state === "LEARNING").length,
        active: models.filter((m) => m.state === "ACTIVE").length,
        manual: models.filter((m) => m.source === "MANUAL").length,
        disabled: models.filter((m) => m.state === "DISABLED").length,
      },
      byEqp,
    };
  }

  listRuns(filter: { eqpId?: string; chamberId?: string; recipeId?: string; limit?: number }) {
    const out = [];
    for (let i = this.runOrder.length - 1; i >= 0 && out.length < (filter.limit ?? 100); i--) {
      const r = this.runs.get(this.runOrder[i]);
      if (!r) continue;
      if (!matchesFilter(r.eqpId, filter.eqpId) || !matchesFilter(r.chamberId, filter.chamberId)) continue;
      if (!matchesFilter(r.recipeId, filter.recipeId)) continue;
      out.push({
        runId: r.runId,
        eqpId: r.eqpId,
        chamberId: r.chamberId,
        lotId: r.lotId,
        waferIds: r.waferIds,
        recipeId: r.recipeId,
        startTs: r.startTs,
        endTs: r.endTs,
        status: r.status,
        faultCount: r.faults.length,
        samples: r.samples.length,
      });
    }
    return out;
  }

  getRun(runId: string) {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    return {
      runId: r.runId,
      eqpId: r.eqpId,
      chamberId: r.chamberId,
      lotId: r.lotId,
      waferIds: r.waferIds,
      recipeId: r.recipeId,
      startTs: r.startTs,
      endTs: r.endTs,
      status: r.status,
      steps: r.steps,
      samples: r.samples,
      indicators: r.indicators,
      faults: r.faults,
    };
  }

  runCsv(runId: string): string | undefined {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    const params = r.samples.length ? Object.keys(r.samples[0].values) : [];
    const head = ["timestamp", "eqp_id", "chamber_id", "run_id", "lot_id", "recipe_id", "step_no", ...params, ...params.map((p) => `${p}_sp`)];
    const rows = r.samples.map((s) =>
      [
        new Date(s.ts).toISOString(),
        r.eqpId,
        r.chamberId,
        r.runId,
        r.lotId,
        r.recipeId,
        s.stepNo,
        ...params.map((p) => s.values[p]),
        ...params.map((p) => s.setpoints[p]),
      ].join(","),
    );
    return [head.join(","), ...rows].join("\n");
  }

  listFaults(filter: { eqpId?: string; limit?: number }) {
    const out: FdcFault[] = [];
    for (let i = this.faults.length - 1; i >= 0 && out.length < (filter.limit ?? 200); i--) {
      if (matchesFilter(this.faults[i].eqpId, filter.eqpId)) out.push(this.faults[i]);
    }
    return out;
  }

  listModels(filter: { eqpId?: string; chamberId?: string; recipeId?: string; param?: string; stat?: string }) {
    return [...this.models.values()]
      .filter(
        (m) =>
          matchesFilter(m.eqpId, filter.eqpId) &&
          matchesFilter(m.chamberId, filter.chamberId) &&
          matchesFilter(m.recipeId, filter.recipeId) &&
          matchesFilter(m.param, filter.param) &&
          matchesFilter(m.stat, filter.stat),
      )
      .map(({ learn, learnSamples, history, ...m }) => ({
        ...m,
        learned: learn.length,
        center: round(m.center, 5),
        sigma: round(m.sigma, 5),
        lcl: round(m.lcl, 5),
        ucl: round(m.ucl, 5),
        lastValue: history[history.length - 1]?.value ?? null,
        violations: history.filter((h) => h.violated).length,
      }));
  }

  trend(key: string) {
    const m = this.models.get(key);
    if (!m) return undefined;
    return {
      key,
      eqpId: m.eqpId,
      chamberId: m.chamberId,
      recipeId: m.recipeId,
      stepNo: m.stepNo,
      stepName: m.stepName,
      param: m.param,
      stat: m.stat,
      state: m.state,
      source: m.source,
      center: m.center,
      lcl: m.lcl,
      ucl: m.ucl,
      history: m.history,
    };
  }

  updateModel(key: string, patch: { lcl?: number; ucl?: number; state?: "ACTIVE" | "DISABLED" }) {
    const m = this.models.get(key);
    if (!m) return undefined;
    if (patch.lcl !== undefined && patch.ucl !== undefined) {
      if (!(patch.ucl > patch.lcl)) throw new Error("UCL must be greater than LCL");
      m.lcl = patch.lcl;
      m.ucl = patch.ucl;
      m.center = (patch.lcl + patch.ucl) / 2;
      m.source = "MANUAL";
      m.state = "ACTIVE";
    }
    if (patch.state) m.state = patch.state;
    return this.trend(key);
  }

  relearn(filter: { eqpId?: string; chamberId?: string; recipeId?: string }): number {
    let n = 0;
    for (const m of this.models.values()) {
      if (!matchesFilter(m.eqpId, filter.eqpId) || !matchesFilter(m.chamberId, filter.chamberId)) continue;
      if (!matchesFilter(m.recipeId, filter.recipeId)) continue;
      m.state = "LEARNING";
      m.source = "AUTO";
      m.learn = [];
      m.learnSamples = [];
      n++;
    }
    return n;
  }

  setConfig(patch: Partial<FdcConfig>) {
    this.config = { ...this.config, ...patch };
    return this.config;
  }
}

/** How far a least-squares line moves across the window. */
function rampTravel(window: Sample[], param: string): number {
  const ts = window.map((s) => s.ts);
  const xs = window.map((s) => s.values[param]);
  const mt = mean(ts);
  const mx = mean(xs);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (ts[i] - mt) * (xs[i] - mx);
    sxx += (ts[i] - mt) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return Math.abs(slope * (ts[ts.length - 1] - ts[0]));
}
