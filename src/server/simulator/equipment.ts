import type {
  ActiveAlarm,
  AlarmCategory,
  AlarmDef,
  AlarmPayload,
  ChamberState,
  ChamberStatus,
  CommandPayload,
  CommandResult,
  ControlState,
  E10State,
  EquipmentConfig,
  EquipmentMode,
  EquipmentStatus,
  EventName,
  FaultInjection,
  LoadPortStatus,
  MetrologyPayload,
  ParameterDef,
  ProcessState,
  Recipe,
  RunContext,
  SlotState,
  StatePayload,
  TracePayload,
} from "../../shared/types";
import type { Rng } from "../../shared/rng";

/** What the equipment emits; the simulator routes it through the vendor link. */
export interface EquipmentOutput {
  trace(t: TracePayload): void;
  event(name: EventName, chamberId: string | null, values: Record<string, string | number>, extra: Record<string, number>): void;
  alarm(a: AlarmPayload): void;
  state(s: StatePayload): void;
  metrology(m: MetrologyPayload): void;
  link(controlState: ControlState): void;
}

export interface EquipmentServices {
  rng: Rng;
  out: EquipmentOutput;
  faults(eqpId: string, chamberId: string): FaultInjection[];
  nextLotId(): string;
  nextCarrierId(): string;
}

interface Run {
  runId: string;
  lotId: string;
  portId: number;
  slots: number[];
  waferIds: string[];
  recipe: Recipe;
  stepIdx: number;
  stepElapsed: number;
  runElapsed: number;
  startedAt: number;
  /** Largest |setpoint| per parameter in the recipe: deviations are relative to it. */
  scale: Record<string, number>;
  devSum: Record<string, number>;
  devCount: Record<string, number>;
}

interface Chamber {
  id: string;
  idx: number;
  values: Record<string, number>;
  measured: Record<string, number>;
  run: Run | null;
  readyAt: number;
  wafersSincePm: number;
  sampleNo: number;
  nextSampleAt: number;
  stuck: Record<string, number>;
  /** Last setpoint per parameter and when it changed, to know when a value has settled. */
  lastSp: Record<string, number>;
  spChangedAt: Record<string, number>;
  /** The equipment interlock arms once a value has reached its new setpoint band. */
  armed: Record<string, boolean>;
  interlockBad: Record<string, number>;
  interlockGood: Record<string, number>;
}

interface Port {
  id: number;
  state: LoadPortStatus["state"];
  carrierId: string | null;
  lotId: string | null;
  recipeId: string | null;
  slots: SlotState[];
  startedAt: number;
  unloadAt: number;
}

interface AlarmRuntime extends ActiveAlarm {
  category: AlarmCategory;
  autoClearSec?: number;
  param?: string;
}

const INTERLOCK_FACTOR = 5;
const INTERLOCK_SAMPLES = 3;
const INTERLOCK_CLEAR_SAMPLES = 5;
const AUTO_UNLOAD_MS = 10_000;

export class Equipment {
  cfg: EquipmentConfig;
  controlState: ControlState = "ONLINE_REMOTE";
  mode: EquipmentMode = "PRODUCTION";
  e10: E10State = "SBY";
  e10Since: number;
  private chambers: Chamber[] = [];
  private ports: Port[] = [];
  private alarms = new Map<string, AlarmRuntime>();
  private pausedByOperator = false;
  private blocked = false;
  private pm = false;
  private pmPending = false;
  /** Duration for the pending PM; 0 = until PM_END. */
  private pmPendingSec = 0;
  private pmEndsAt = 0;
  private holdReason: string | null = null;
  private holdAt = 0;
  private nextLotAt: number;
  private runSeq = 0;
  private now: number;
  wafersProcessed = 0;
  lotsProcessed = 0;
  private svc: EquipmentServices;

  constructor(cfg: EquipmentConfig, svc: EquipmentServices, now: number) {
    this.cfg = cfg;
    this.svc = svc;
    this.now = now;
    this.e10Since = now;
    this.nextLotAt = now + 2000 + svc.rng.next() * 8000;
    this.build();
  }

  private build() {
    this.chambers = this.cfg.chambers.map((id, idx) => {
      const values: Record<string, number> = {};
      for (const p of this.cfg.parameters) values[p.key] = p.idle;
      return {
        id,
        idx,
        values,
        measured: { ...values },
        run: null,
        readyAt: this.now,
        wafersSincePm: 0,
        sampleNo: 0,
        nextSampleAt: this.now,
        stuck: {},
        lastSp: {},
        spChangedAt: {},
        armed: {},
        interlockBad: {},
        interlockGood: {},
      };
    });
    this.ports = Array.from({ length: this.cfg.loadPorts }, (_, i) => this.emptyPort(i + 1));
  }

  private emptyPort(id: number): Port {
    return { id, state: "EMPTY", carrierId: null, lotId: null, recipeId: null, slots: [], startedAt: 0, unloadAt: 0 };
  }

  /** Swap configuration; structural changes rebuild the tool (runs are dropped). */
  reconfigure(cfg: EquipmentConfig) {
    const structural =
      cfg.chambers.join() !== this.cfg.chambers.join() ||
      cfg.loadPorts !== this.cfg.loadPorts ||
      cfg.processMode !== this.cfg.processMode ||
      cfg.parameters.map((p) => p.key).join() !== this.cfg.parameters.map((p) => p.key).join();
    this.cfg = cfg;
    if (structural) {
      this.alarms.clear();
      this.build();
      this.refresh("reconfigured");
    }
  }

  // ------------------------------------------------------------- helpers

  private get gen() {
    return this.cfg.generation;
  }

  private hasStoppingAlarm(): boolean {
    for (const a of this.alarms.values()) if (a.stopsEquipment) return true;
    return false;
  }

  private activeRuns(): Run[] {
    return this.chambers.flatMap((c) => (c.run ? [c.run] : []));
  }

  private setpointsFor(ch: Chamber): Record<string, number> {
    const sp: Record<string, number> = {};
    const step = ch.run && !this.blocked ? ch.run.recipe.steps[ch.run.stepIdx] : null;
    for (const p of this.cfg.parameters) sp[p.key] = step?.setpoints[p.key] ?? p.idle;
    return sp;
  }

  private context(ch: Chamber): RunContext | null {
    const r = ch.run;
    if (!r) return null;
    return {
      runId: r.runId,
      lotId: r.lotId,
      waferIds: r.waferIds,
      recipeId: r.recipe.id,
      stepNo: r.stepIdx + 1,
      stepName: r.recipe.steps[r.stepIdx]?.name ?? "",
    };
  }

  private emit(name: EventName, chamberId: string | null, values: Record<string, string | number>) {
    if (!this.gen.eventsEnabled[name]) return;
    const extra: Record<string, number> = {};
    const vars = this.gen.eventReportVars[name] ?? [];
    if (vars.length) {
      const ch = this.chambers.find((c) => c.id === chamberId) ?? this.chambers[0];
      for (const key of vars) if (ch && key in ch.measured) extra[key] = round(ch.measured[key]);
    }
    const base: Record<string, string | number> = { EqpID: this.cfg.id, Clock: new Date(this.now).toISOString() };
    if (chamberId) base.ChamberID = chamberId;
    this.svc.out.event(name, chamberId, { ...base, ...values }, extra);
  }

  private runValues(ch: Chamber, run: Run): Record<string, string | number> {
    return {
      RunID: run.runId,
      LotID: run.lotId,
      WaferID: run.waferIds.join(","),
      SlotNo: run.slots.join(","),
      RecipeID: run.recipe.id,
      ChamberID: ch.id,
    };
  }

  // ------------------------------------------------------------ state

  private computeE10(): E10State {
    if (this.mode === "NONSCHEDULED") return "NST";
    if (this.pm) return "SDT";
    if (this.hasStoppingAlarm()) return "UDT";
    if (this.holdReason && !this.activeRuns().length) return "UDT";
    if (this.mode === "ENGINEERING") return "ENG";
    if (this.activeRuns().length && !this.blocked) return "PRD";
    return "SBY";
  }

  processState(): ProcessState {
    const runs = this.activeRuns().length;
    if (!runs) return "IDLE";
    return this.blocked ? "PAUSED" : "EXECUTING";
  }

  private refresh(reason: string) {
    const blocked = this.pausedByOperator || this.hasStoppingAlarm();
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      const why = this.pausedByOperator ? "OPERATOR" : "ALARM";
      for (const ch of this.chambers) {
        if (!ch.run) continue;
        this.emit(blocked ? "PROCESS_PAUSED" : "PROCESS_RESUMED", ch.id, {
          RunID: ch.run.runId,
          LotID: ch.run.lotId,
          Reason: blocked ? why : "RESUME",
        });
      }
    }
    const next = this.computeE10();
    if (next !== this.e10) {
      const prev = this.e10;
      this.e10 = next;
      this.e10Since = this.now;
      this.emit("EQUIPMENT_STATE_CHANGED", null, {
        E10State: next,
        PrevE10State: prev,
        ProcessState: this.processState(),
        Reason: reason,
      });
      this.svc.out.state({
        eqpId: this.cfg.id,
        e10: next,
        prevE10: prev,
        controlState: this.controlState,
        processState: this.processState(),
        reason,
      });
    }
  }

  // ------------------------------------------------------------ alarms

  private setAlarm(def: AlarmDef, chamberId: string | null) {
    const key = `${def.code}|${chamberId ?? ""}`;
    if (this.alarms.has(key)) return;
    this.alarms.set(key, {
      code: def.code,
      alid: def.alid,
      text: def.text,
      severity: def.severity,
      chamberId,
      setAt: this.now,
      stopsEquipment: def.stopsEquipment,
      category: def.category,
      autoClearSec: def.autoClearSec,
      param: def.param,
    });
    this.svc.out.alarm({
      eqpId: this.cfg.id,
      chamberId,
      alid: def.alid,
      code: def.code,
      text: def.text,
      severity: def.severity,
      category: def.category,
      set: true,
    });
    this.emit("ALARM_SET", chamberId, { ALID: def.alid, AlarmCode: def.code, AlarmText: def.text, Severity: def.severity });
    this.refresh(`alarm ${def.code}`);
  }

  private clearAlarm(key: string, reason: string) {
    const a = this.alarms.get(key);
    if (!a) return;
    this.alarms.delete(key);
    this.svc.out.alarm({
      eqpId: this.cfg.id,
      chamberId: a.chamberId,
      alid: a.alid,
      code: a.code,
      text: a.text,
      severity: a.severity,
      category: a.category,
      set: false,
    });
    this.emit("ALARM_CLEARED", a.chamberId, { ALID: a.alid, AlarmCode: a.code, AlarmText: a.text, Reason: reason });
    this.refresh(`alarm cleared ${a.code}`);
  }

  // ------------------------------------------------------------- lots

  private loadCarrier(portId: number | undefined, recipeId: string | undefined, wafers: number | undefined, lotId?: string): CommandResult {
    const port = portId ? this.ports.find((p) => p.id === portId) : this.ports.find((p) => p.state === "EMPTY");
    if (!port) return { ok: false, message: "No empty load port" };
    if (port.state !== "EMPTY") return { ok: false, message: `Load port ${port.id} is not empty` };
    const recipe = this.cfg.recipes.find((r) => r.id === (recipeId || this.gen.defaultRecipeId)) ?? this.cfg.recipes[0];
    if (!recipe) return { ok: false, message: "No recipe configured" };
    const count = clampInt(wafers ?? this.gen.wafersPerLot, 1, 25);
    port.state = "LOADED";
    port.carrierId = this.svc.nextCarrierId();
    port.lotId = lotId || this.svc.nextLotId();
    port.recipeId = recipe.id;
    port.slots = Array.from({ length: 25 }, (_, i) => (i < count ? "WAITING" : "EMPTY"));
    this.emit("CARRIER_ARRIVED", null, {
      PortID: port.id,
      CarrierID: port.carrierId,
      LotID: port.lotId,
      RecipeID: recipe.id,
      WaferCount: count,
    });
    return { ok: true, message: `Carrier ${port.carrierId} (${port.lotId}) loaded on LP${port.id}` };
  }

  private startLot(portId: number | undefined): CommandResult {
    const port = portId ? this.ports.find((p) => p.id === portId) : this.ports.find((p) => p.state === "LOADED");
    if (!port || port.state !== "LOADED") return { ok: false, message: "No loaded carrier to start" };
    if (this.mode === "NONSCHEDULED") return { ok: false, message: "Equipment is non-scheduled" };
    port.state = "PROCESSING";
    port.startedAt = this.now;
    this.emit("LOT_START", null, {
      PortID: port.id,
      CarrierID: port.carrierId ?? "",
      LotID: port.lotId ?? "",
      RecipeID: port.recipeId ?? "",
      WaferCount: port.slots.filter((s) => s !== "EMPTY").length,
    });
    return { ok: true, message: `Lot ${port.lotId} started` };
  }

  private unload(port: Port): CommandResult {
    if (port.state === "PROCESSING") return { ok: false, message: "Lot is processing" };
    if (port.state === "EMPTY") return { ok: false, message: "Port already empty" };
    this.emit("CARRIER_REMOVED", null, { PortID: port.id, CarrierID: port.carrierId ?? "", LotID: port.lotId ?? "" });
    Object.assign(port, this.emptyPort(port.id));
    return { ok: true, message: `LP${port.id} unloaded` };
  }

  private finishLotIfDone(port: Port) {
    if (port.state !== "PROCESSING") return;
    if (port.slots.some((s) => s === "WAITING" || s === "PROCESSING")) return;
    const processed = port.slots.filter((s) => s === "DONE").length;
    const aborted = port.slots.filter((s) => s === "ABORTED").length;
    port.state = "COMPLETE";
    port.unloadAt = this.now + AUTO_UNLOAD_MS;
    this.lotsProcessed++;
    this.emit("LOT_END", null, {
      PortID: port.id,
      LotID: port.lotId ?? "",
      RecipeID: port.recipeId ?? "",
      WaferCount: processed + aborted,
      ProcessedCount: processed,
      Result: aborted ? "ABORTED" : "OK",
      LotTime: round((this.now - port.startedAt) / 1000),
    });
  }

  // ------------------------------------------------------------- runs

  private canDispatch(): boolean {
    return !this.blocked && !this.pm && !this.pmPending && !this.holdReason && this.mode !== "NONSCHEDULED";
  }

  private dispatch() {
    if (!this.canDispatch()) return;
    for (const ch of this.chambers) {
      if (ch.run || this.now < ch.readyAt) continue;
      const port = this.ports.find((p) => p.state === "PROCESSING" && p.slots.includes("WAITING"));
      if (!port) return;
      const recipe = this.cfg.recipes.find((r) => r.id === port.recipeId);
      if (!recipe) {
        port.slots = port.slots.map((s) => (s === "WAITING" ? "ABORTED" : s));
        this.finishLotIfDone(port);
        continue;
      }
      const slots: number[] = [];
      port.slots.forEach((s, i) => {
        if (s === "WAITING" && (this.cfg.processMode === "batch" || slots.length === 0)) slots.push(i);
      });
      for (const i of slots) port.slots[i] = "PROCESSING";
      const run: Run = {
        runId: `${this.cfg.id}-${ch.id}-${String(++this.runSeq).padStart(5, "0")}`,
        lotId: port.lotId ?? "",
        portId: port.id,
        slots: slots.map((i) => i + 1),
        waferIds: slots.map((i) => `${port.lotId}.${String(i + 1).padStart(2, "0")}`),
        recipe: structuredClone(recipe),
        stepIdx: 0,
        stepElapsed: 0,
        runElapsed: 0,
        startedAt: this.now,
        scale: recipeScale(recipe),
        devSum: {},
        devCount: {},
      };
      ch.run = run;
      this.emit("PROCESS_START", ch.id, this.runValues(ch, run));
      this.emitStep("STEP_START", ch, run);
      this.refresh("process start");
    }
  }

  private emitStep(name: "STEP_START" | "STEP_END", ch: Chamber, run: Run) {
    const step = run.recipe.steps[run.stepIdx];
    this.emit(name, ch.id, {
      ...this.runValues(ch, run),
      StepNo: run.stepIdx + 1,
      StepName: step?.name ?? "",
      ...(name === "STEP_END" ? { StepTime: round(run.stepElapsed / 1000) } : {}),
    });
  }

  private advanceRun(ch: Chamber, dt: number) {
    const run = ch.run;
    if (!run || this.blocked) return;
    run.stepElapsed += dt;
    run.runElapsed += dt;
    const step = run.recipe.steps[run.stepIdx];
    if (run.stepElapsed < step.duration * 1000) return;
    this.emitStep("STEP_END", ch, run);
    if (run.stepIdx + 1 < run.recipe.steps.length) {
      run.stepIdx++;
      run.stepElapsed = 0;
      this.emitStep("STEP_START", ch, run);
      return;
    }
    this.completeRun(ch, run);
  }

  private completeRun(ch: Chamber, run: Run) {
    const port = this.ports.find((p) => p.id === run.portId);
    this.emit("PROCESS_END", ch.id, {
      ...this.runValues(ch, run),
      ProcessTime: round(run.runElapsed / 1000),
      Result: "OK",
    });
    for (const s of run.slots) if (port) port.slots[s - 1] = "DONE";
    this.wafersProcessed += run.waferIds.length;
    ch.wafersSincePm += run.waferIds.length;
    ch.run = null;
    ch.readyAt = this.now + this.gen.transferSec * 1000;
    ch.interlockBad = {};
    this.measure(ch, run);
    this.clearParamAlarms(ch.id);
    if (port) this.finishLotIfDone(port);
    if (this.gen.pmIntervalWafers > 0 && ch.wafersSincePm >= this.gen.pmIntervalWafers && !this.pmPending) {
      this.pmPending = true;
      this.pmPendingSec = this.gen.pmDurationSec;
    }
    this.refresh("process end");
  }

  private abortAll(reason: string) {
    for (const ch of this.chambers) {
      const run = ch.run;
      if (!run) continue;
      this.emit("PROCESS_ABORTED", ch.id, { ...this.runValues(ch, run), Reason: reason });
      const port = this.ports.find((p) => p.id === run.portId);
      for (const s of run.slots) if (port) port.slots[s - 1] = "ABORTED";
      ch.run = null;
      ch.readyAt = this.now + this.gen.transferSec * 1000;
    }
    for (const port of this.ports) {
      if (port.state !== "PROCESSING") continue;
      port.slots = port.slots.map((s) => (s === "WAITING" ? "ABORTED" : s));
      this.finishLotIfDone(port);
    }
    this.refresh(`abort: ${reason}`);
  }

  private measure(ch: Chamber, run: Run) {
    if (!this.cfg.metrology.length) return;
    const dev: Record<string, number> = {};
    for (const k of Object.keys(run.devSum)) dev[k] = run.devSum[k] / Math.max(1, run.devCount[k]);
    const n = this.chambers.length;
    const agingBase = this.gen.driftPerWafer * ch.wafersSincePm;
    run.waferIds.forEach((waferId) => {
      if (!this.svc.rng.chance(this.gen.metrologyRate)) return;
      const items = this.cfg.metrology.map((item) => {
        let rel = 0;
        for (const [param, coef] of Object.entries(item.sensitivity)) {
          const d = dev[param] ?? 0;
          rel += coef * (item.absolute ? Math.abs(d) : d);
        }
        const chamberBias = item.noise * 0.6 * (ch.idx - (n - 1) / 2);
        const value =
          item.target * (1 + rel + (item.aging ?? 0) * agingBase) + chamberBias + this.svc.rng.gauss() * item.noise;
        return {
          key: item.key,
          name: item.name,
          unit: item.unit,
          value: round(value, 4),
          target: item.target,
          usl: item.usl,
          lsl: item.lsl,
        };
      });
      this.svc.out.metrology({
        eqpId: this.cfg.id,
        eqpType: this.cfg.type,
        chamberId: ch.id,
        runId: run.runId,
        lotId: run.lotId,
        waferId,
        recipeId: run.recipe.id,
        items,
      });
    });
  }

  // ----------------------------------------------------------- physics

  private sample(ch: Chamber) {
    const sp = this.setpointsFor(ch);
    const faults = this.svc.faults(this.cfg.id, ch.id);
    const processing = !!ch.run && !this.blocked;
    const step = processing ? ch.run!.recipe.steps[ch.run!.stepIdx] : null;
    const aging = this.gen.driftPerWafer * ch.wafersSincePm;
    for (const p of this.cfg.parameters) {
      let sigma = p.noise * this.gen.noiseScale;
      let offset = (p.aging ?? 0) * aging * sp[p.key];
      let value: number | null = null;
      for (const f of faults) {
        if (f.param !== p.key || (f.processOnly && !processing)) continue;
        switch (f.type) {
          case "SHIFT":
            offset += f.magnitude;
            break;
          case "DRIFT":
            offset += (f.magnitude * (this.now - f.startedAt)) / 60_000;
            break;
          case "SPIKE":
            if (this.svc.rng.chance(f.probability)) offset += f.magnitude * (this.svc.rng.chance(0.5) ? 1 : -1);
            break;
          case "NOISE":
            sigma *= Math.max(0, f.magnitude);
            break;
          case "STUCK":
            if (!(f.id in ch.stuck)) ch.stuck[f.id] = ch.measured[p.key];
            value = ch.stuck[f.id];
            break;
          case "DROPOUT":
            if (this.svc.rng.chance(f.probability)) value = 0;
            break;
        }
      }
      if (value === null) value = ch.values[p.key] + offset + this.svc.rng.gauss() * sigma;
      ch.measured[p.key] = clamp(value, p.min, p.max);
    }
    // Forget stuck values of faults that are gone.
    for (const id of Object.keys(ch.stuck)) if (!faults.some((f) => f.id === id)) delete ch.stuck[id];

    if (processing && step) {
      const run = ch.run!;
      for (const p of this.cfg.parameters) {
        const target = sp[p.key];
        const since = this.now - (ch.spChangedAt[p.key] ?? 0);
        const err = Math.abs(ch.measured[p.key] - target);
        if (!ch.armed[p.key] && (err <= INTERLOCK_FACTOR * p.tolerance || since > (6 * p.tau + 10) * 1000)) {
          ch.armed[p.key] = true;
        }
        const scale = run.scale[p.key];
        if (since > 3 * p.tau * 1000 && scale) {
          run.devSum[p.key] = (run.devSum[p.key] ?? 0) + (ch.measured[p.key] - target) / scale;
          run.devCount[p.key] = (run.devCount[p.key] ?? 0) + 1;
        }
        if (ch.armed[p.key]) this.checkInterlock(ch, p, err > INTERLOCK_FACTOR * p.tolerance);
      }
    }

    ch.sampleNo++;
    if (!this.gen.traceEnabled || (!processing && !this.gen.traceIdle && !ch.run)) return;
    const keys = this.gen.traceParams.length
      ? this.cfg.parameters.filter((p) => this.gen.traceParams.includes(p.key)).map((p) => p.key)
      : this.cfg.parameters.map((p) => p.key);
    const values: Record<string, number> = {};
    const setpoints: Record<string, number> = {};
    for (const k of keys) {
      values[k] = round(ch.measured[k], 4);
      setpoints[k] = sp[k];
    }
    this.svc.out.trace({ eqpId: this.cfg.id, chamberId: ch.id, sampleNo: ch.sampleNo, context: this.context(ch), values, setpoints });
  }

  private checkInterlock(ch: Chamber, p: ParameterDef, bad: boolean) {
    const def = this.cfg.alarms.find((a) => a.param === p.key);
    if (!def) return;
    const key = `${def.code}|${ch.id}`;
    if (bad) {
      ch.interlockGood[p.key] = 0;
      ch.interlockBad[p.key] = (ch.interlockBad[p.key] ?? 0) + 1;
      if (ch.interlockBad[p.key] >= INTERLOCK_SAMPLES) this.setAlarm(def, ch.id);
    } else {
      ch.interlockBad[p.key] = 0;
      ch.interlockGood[p.key] = (ch.interlockGood[p.key] ?? 0) + 1;
      if (this.alarms.has(key) && ch.interlockGood[p.key] >= INTERLOCK_CLEAR_SAMPLES) this.clearAlarm(key, "back in range");
    }
  }

  private clearParamAlarms(chamberId: string) {
    for (const [key, a] of this.alarms) if (a.param && a.chamberId === chamberId) this.clearAlarm(key, "run ended");
  }

  private physics(ch: Chamber, dt: number) {
    const sp = this.setpointsFor(ch);
    for (const p of this.cfg.parameters) {
      if (ch.lastSp[p.key] !== sp[p.key]) {
        ch.lastSp[p.key] = sp[p.key];
        ch.spChangedAt[p.key] = this.now;
        ch.armed[p.key] = false;
      }
      const k = Math.exp(-dt / 1000 / Math.max(0.05, p.tau));
      ch.values[p.key] = sp[p.key] + (ch.values[p.key] - sp[p.key]) * k;
    }
  }

  // -------------------------------------------------------------- tick

  advance(now: number, dt: number) {
    this.now = now;
    this.housekeeping(dt);
    this.dispatch();
    const interval = clamp(this.gen.traceIntervalMs, 100, 60_000);
    for (const ch of this.chambers) {
      this.advanceRun(ch, dt);
      this.physics(ch, dt);
      if (now >= ch.nextSampleAt) {
        this.sample(ch);
        ch.nextSampleAt += interval;
        if (ch.nextSampleAt <= now) ch.nextSampleAt = now + interval;
      }
    }
  }

  private housekeeping(dt: number) {
    const g = this.gen;
    for (const [key, a] of this.alarms) {
      const age = (this.now - a.setAt) / 1000;
      if (a.autoClearSec && age >= a.autoClearSec) this.clearAlarm(key, "auto clear");
      else if (a.stopsEquipment && g.autoRecoverSec > 0 && age >= g.autoRecoverSec) this.clearAlarm(key, "auto recover");
    }
    if (this.holdReason && g.autoRecoverSec > 0 && this.now - this.holdAt >= g.autoRecoverSec * 1000) {
      this.holdReason = null;
      this.refresh("hold auto released");
    }
    if (this.pm && this.now >= this.pmEndsAt && this.pmEndsAt > 0) this.endPm("PM complete");
    if (this.pmPending && !this.pm && !this.activeRuns().length) this.startPm(this.pmPendingSec, "scheduled PM");

    for (const port of this.ports) {
      if (port.state === "COMPLETE" && this.now >= port.unloadAt) this.unload(port);
    }

    if (g.alarmRatePerHour > 0 && this.svc.rng.chance((g.alarmRatePerHour / 3600) * (dt / 1000))) {
      const pool = this.cfg.alarms.filter((a) => !a.param);
      if (pool.length) {
        const weighted = pool.flatMap((a) => (a.severity === "WARNING" ? [a, a, a, a] : [a]));
        const def = this.svc.rng.pick(weighted);
        const chamberId = def.category === "UTILITY" ? null : this.svc.rng.pick(this.chambers).id;
        this.setAlarm(def, chamberId);
      }
    }

    if (
      g.autoRun &&
      this.controlState === "ONLINE_REMOTE" &&
      this.mode === "PRODUCTION" &&
      !this.pm &&
      this.now >= this.nextLotAt
    ) {
      this.nextLotAt = this.now + g.lotIntervalSec * 1000 * (0.8 + 0.4 * this.svc.rng.next());
      const queued = this.ports.filter((p) => p.state === "LOADED" || p.state === "PROCESSING").length;
      if (queued < this.cfg.loadPorts && this.ports.some((p) => p.state === "EMPTY")) {
        const res = this.loadCarrier(undefined, undefined, undefined);
        if (res.ok) this.startLot(undefined);
      }
    }
  }

  private startPm(durationSec: number, reason: string) {
    this.pm = true;
    this.pmPending = false;
    this.pmEndsAt = durationSec > 0 ? this.now + durationSec * 1000 : 0;
    this.emit("PM_START", null, { Reason: reason, DurationSec: durationSec });
    this.refresh(reason);
  }

  private endPm(reason: string) {
    this.pm = false;
    this.pmEndsAt = 0;
    const wafers = Math.max(...this.chambers.map((c) => c.wafersSincePm));
    for (const ch of this.chambers) ch.wafersSincePm = 0;
    this.emit("PM_END", null, { Reason: reason, WafersSincePm: wafers });
    this.refresh(reason);
  }

  // ------------------------------------------------------------ commands

  command(cmd: CommandPayload): CommandResult {
    const res = this.execute(cmd);
    if (cmd.origin === "HOST" && this.controlState !== "OFFLINE") {
      this.emit("REMOTE_COMMAND", null, { RCMD: cmd.action, Result: res.ok ? "ACK" : "NAK", RequestedBy: cmd.requestedBy });
    }
    return res;
  }

  private execute(cmd: CommandPayload): CommandResult {
    const a = cmd.args ?? {};
    if (cmd.origin === "HOST" && this.controlState !== "ONLINE_REMOTE") {
      return { ok: false, message: `Rejected: equipment is ${this.controlState}, host commands need ONLINE_REMOTE` };
    }
    switch (cmd.action) {
      case "ONLINE_REMOTE":
      case "ONLINE_LOCAL":
      case "OFFLINE":
        return this.setControl(cmd.action);
      case "LOAD_CARRIER": {
        const res = this.loadCarrier(
          num(a.port),
          a.recipeId ? String(a.recipeId) : undefined,
          num(a.wafers),
          a.lotId ? String(a.lotId) : undefined,
        );
        if (res.ok && a.autoStart) this.startLot(undefined);
        return res;
      }
      case "START_LOT":
        return this.startLot(num(a.port));
      case "UNLOAD_CARRIER": {
        const port = this.ports.find((p) => p.id === num(a.port));
        return port ? this.unload(port) : { ok: false, message: "Unknown port" };
      }
      case "PAUSE":
        if (this.pausedByOperator) return { ok: false, message: "Already paused" };
        this.pausedByOperator = true;
        this.refresh("operator pause");
        return { ok: true, message: "Paused" };
      case "RESUME":
        if (!this.pausedByOperator) return { ok: false, message: "Not paused" };
        this.pausedByOperator = false;
        this.refresh("operator resume");
        return {
          ok: true,
          message: this.hasStoppingAlarm() ? "Resume pending: reset the stopping alarm first" : "Resumed",
        };
      case "ABORT":
        if (!this.activeRuns().length && !this.ports.some((p) => p.state === "PROCESSING"))
          return { ok: false, message: "Nothing to abort" };
        this.abortAll(String(a.reason ?? cmd.requestedBy));
        return { ok: true, message: "Aborted" };
      case "ALARM_RESET": {
        const keys = [...this.alarms.keys()].filter((k) => !a.code || k.startsWith(`${a.code}|`));
        if (!keys.length) return { ok: false, message: "No active alarms" };
        for (const k of keys) this.clearAlarm(k, `reset by ${cmd.requestedBy}`);
        return { ok: true, message: `${keys.length} alarm(s) reset` };
      }
      case "RAISE_ALARM": {
        const def = this.cfg.alarms.find((d) => d.code === a.code);
        if (!def) return { ok: false, message: `Unknown alarm ${a.code}` };
        const chamberId = a.chamberId ? String(a.chamberId) : null;
        this.setAlarm(def, chamberId);
        return { ok: true, message: `Alarm ${def.code} raised` };
      }
      case "PM_START":
        if (this.pm) return { ok: false, message: "Already in PM" };
        if (this.activeRuns().length) {
          this.pmPending = true;
          this.pmPendingSec = num(a.durationSec) ?? 0;
          return { ok: true, message: "PM will start after the current runs" };
        }
        this.startPm(num(a.durationSec) ?? 0, `manual PM by ${cmd.requestedBy}`);
        return { ok: true, message: "PM started" };
      case "PM_END":
        if (!this.pm) {
          if (this.pmPending) {
            this.pmPending = false;
            return { ok: true, message: "Pending PM cancelled" };
          }
          return { ok: false, message: "Not in PM" };
        }
        this.endPm(`PM ended by ${cmd.requestedBy}`);
        return { ok: true, message: "PM ended" };
      case "SET_MODE": {
        const mode = String(a.mode) as EquipmentMode;
        if (!["PRODUCTION", "ENGINEERING", "NONSCHEDULED"].includes(mode)) return { ok: false, message: "Bad mode" };
        this.mode = mode;
        this.refresh(`mode ${mode}`);
        return { ok: true, message: `Mode ${mode}` };
      }
      case "HOLD":
        this.holdReason = String(a.reason ?? `hold by ${cmd.requestedBy}`);
        this.holdAt = this.now;
        this.refresh(`hold: ${this.holdReason}`);
        return { ok: true, message: "Equipment held: no new runs until released" };
      case "RELEASE_HOLD":
        if (!this.holdReason) return { ok: false, message: "Not held" };
        this.holdReason = null;
        this.refresh("hold released");
        return { ok: true, message: "Hold released" };
    }
  }

  private setControl(next: ControlState): CommandResult {
    if (next === this.controlState) return { ok: false, message: `Already ${next}` };
    const prev = this.controlState;
    if (next === "OFFLINE") this.emit("CONTROL_STATE_CHANGED", null, { ControlState: next, PrevControlState: prev });
    this.controlState = next;
    if (next !== "OFFLINE") this.emit("CONTROL_STATE_CHANGED", null, { ControlState: next, PrevControlState: prev });
    this.svc.out.link(next);
    this.svc.out.state({
      eqpId: this.cfg.id,
      e10: this.e10,
      prevE10: this.e10,
      controlState: next,
      processState: this.processState(),
      reason: `control ${next}`,
    });
    return { ok: true, message: `Control state ${next}` };
  }

  // ------------------------------------------------------------ status

  status(): EquipmentStatus {
    return {
      id: this.cfg.id,
      controlState: this.controlState,
      processState: this.processState(),
      e10: this.e10,
      e10Since: this.e10Since,
      mode: this.mode,
      pm: this.pm,
      chambers: this.chambers.map((ch) => this.chamberStatus(ch)),
      loadPorts: this.ports.map((p) => ({
        id: p.id,
        state: p.state,
        carrierId: p.carrierId,
        lotId: p.lotId,
        recipeId: p.recipeId,
        slots: [...p.slots],
      })),
      activeAlarms: [...this.alarms.values()].map(({ code, alid, text, severity, chamberId, setAt, stopsEquipment }) => ({
        code,
        alid,
        text,
        severity,
        chamberId,
        setAt,
        stopsEquipment,
      })),
      wafersProcessed: this.wafersProcessed,
      lotsProcessed: this.lotsProcessed,
      holdReason: this.holdReason ?? (this.pmPending ? "PM pending" : null),
    };
  }

  private chamberStatus(ch: Chamber): ChamberStatus {
    const run = ch.run;
    const step = run?.recipe.steps[run.stepIdx];
    const chamberAlarm = [...this.alarms.values()].some((a) => a.stopsEquipment && (!a.chamberId || a.chamberId === ch.id));
    let state: ChamberState = "IDLE";
    if (this.pm) state = "PM";
    else if (run && this.blocked) state = "PAUSED";
    else if (run) state = "PROCESSING";
    else if (chamberAlarm) state = "DOWN";
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(ch.measured)) values[k] = round(v, 4);
    return {
      id: ch.id,
      state,
      run: this.context(ch),
      stepElapsed: run ? run.stepElapsed / 1000 : 0,
      stepDuration: step?.duration ?? 0,
      runElapsed: run ? run.runElapsed / 1000 : 0,
      runDuration: run ? run.recipe.steps.reduce((s, x) => s + x.duration, 0) : 0,
      values,
      setpoints: this.setpointsFor(ch),
      wafersSincePm: ch.wafersSincePm,
    };
  }
}

function recipeScale(recipe: Recipe): Record<string, number> {
  const scale: Record<string, number> = {};
  for (const step of recipe.steps) {
    for (const [k, v] of Object.entries(step.setpoints)) scale[k] = Math.max(scale[k] ?? 0, Math.abs(v));
  }
  return scale;
}

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(Number.isFinite(v) ? v : lo, lo, hi));
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
