import type {
  CommandPayload,
  CommandResult,
  Envelope,
  EquipmentConfig,
  EquipmentInfoPayload,
  EquipmentStatus,
  EventPayload,
  FaultInjection,
  MessageKind,
  SimStatus,
} from "../../shared/types";
import { topics } from "../../shared/topics";
import { Rng } from "../../shared/rng";
import type { MessageBus } from "../bus/message-bus";
import { Equipment } from "./equipment";
import { VendorLink } from "./vendors";

export type LocalListener = (msg: Envelope) => void;

interface Tool {
  eq: Equipment;
  link: VendorLink;
  events: Envelope<EventPayload>[];
}

const STEP_MS = 100;
const EVENT_HISTORY = 300;

/**
 * Owns the simulated clock and every tool. Equipment output is encoded by the
 * vendor driver, decoded by the unified adapter, then:
 *  - always delivered to the local feed (the unified equipment UI is local to
 *    the tool and keeps showing data while the host link is offline), and
 *  - published on the bus to the fab systems only while the tool is online.
 */
export class Simulator {
  readonly bus: MessageBus;
  private tools = new Map<string, Tool>();
  private faults: FaultInjection[] = [];
  private faultIndex = new Map<string, FaultInjection[]>();
  private listeners = new Set<LocalListener>();
  private rng: Rng;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReal = 0;
  private localSeq = 0;
  private lotSeq = 0;
  private carrierSeq = 0;
  private faultSeq = 0;
  status: SimStatus;

  constructor(bus: MessageBus, opts: { seed?: number; speed?: number; startTime?: number } = {}) {
    this.bus = bus;
    const seed = opts.seed ?? 20261014;
    const start = opts.startTime ?? Date.now();
    this.rng = new Rng(seed);
    this.status = { running: false, speed: opts.speed ?? 1, simTime: start, startedAt: start, seed, tick: 0 };
    bus.subscribe("EQUIPMENT", "eqp/+/cmd", (msg) => {
      const cmd = msg.payload as CommandPayload;
      this.command(cmd.eqpId, { ...cmd, origin: "HOST" });
    }, "Host remote commands → equipment");
  }

  // ------------------------------------------------------------- clock

  start() {
    if (this.timer) return;
    this.status.running = true;
    this.lastReal = performance.now();
    this.timer = setInterval(() => this.onTimer(), STEP_MS);
  }

  pause() {
    this.status.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setSpeed(speed: number) {
    this.status.speed = Math.min(120, Math.max(0.1, speed));
  }

  private onTimer() {
    const real = performance.now();
    const elapsed = Math.min(1000, real - this.lastReal);
    this.lastReal = real;
    this.runFor(elapsed * this.status.speed);
  }

  /** Advance simulated time synchronously (tests and the timer both use this). */
  runFor(simMs: number) {
    let left = simMs;
    while (left > 0) {
      const dt = Math.min(STEP_MS, left);
      left -= dt;
      this.status.simTime += dt;
      this.status.tick++;
      this.expireFaults();
      for (const tool of this.tools.values()) tool.eq.advance(this.status.simTime, dt);
    }
  }

  now(): number {
    return this.status.simTime;
  }

  // --------------------------------------------------------- equipment

  load(configs: EquipmentConfig[], faults: FaultInjection[] = []) {
    const keep = new Set(configs.map((c) => c.id));
    for (const [id, tool] of this.tools) {
      if (!keep.has(id)) this.bus.publish(topics.info(id), "info", "MASTER-DATA", { ...infoOf(tool.eq.cfg), removed: true }, this.now());
    }
    this.tools.clear();
    for (const cfg of configs) this.addEquipment(cfg);
    this.faults = faults.map((f) => ({ ...f }));
    this.faultSeq = this.faults.reduce((m, f) => Math.max(m, Number(f.id.replace(/\D/g, "")) || 0), 0);
    this.indexFaults();
  }

  reset(configs: EquipmentConfig[], faults: FaultInjection[], seed?: number) {
    const running = this.status.running;
    this.pause();
    if (seed !== undefined) this.status.seed = seed;
    this.rng = new Rng(this.status.seed);
    const start = Date.now();
    this.status = { ...this.status, simTime: start, startedAt: start, tick: 0 };
    this.lotSeq = 0;
    this.carrierSeq = 0;
    this.load(configs, faults);
    for (const f of this.faults) f.startedAt = start;
    if (running) this.start();
  }

  configs(): EquipmentConfig[] {
    return [...this.tools.values()].map((t) => t.eq.cfg);
  }

  config(id: string): EquipmentConfig | undefined {
    return this.tools.get(id)?.eq.cfg;
  }

  has(id: string) {
    return this.tools.has(id);
  }

  addEquipment(cfg: EquipmentConfig) {
    if (this.tools.has(cfg.id)) throw new Error(`Equipment ${cfg.id} already exists`);
    const link = new VendorLink(cfg);
    const tool: Tool = { eq: null as unknown as Equipment, link, events: [] };
    const eqpId = cfg.id;
    tool.eq = new Equipment(
      cfg,
      {
        rng: this.rng,
        faults: (id, chamberId) => this.faultIndex.get(`${id}|${chamberId}`) ?? [],
        nextLotId: () => `LT${String(++this.lotSeq).padStart(6, "0")}`,
        nextCarrierId: () => `FP${String(++this.carrierSeq).padStart(4, "0")}`,
        out: {
          trace: (t) => {
            const decoded = link.trace(t, this.now());
            this.route(tool, topics.trace(eqpId, decoded.chamberId), "trace", decoded);
          },
          event: (name, chamberId, values, extra) => {
            const reports = [{ rptid: 1, values }];
            if (Object.keys(extra).length) reports.push({ rptid: 2, values: extra });
            const decoded = link.event({ eqpId, ceid: 0, name, chamberId, reports }, this.now());
            const env = this.route(tool, topics.event(eqpId), "event", decoded);
            tool.events.push(env);
            if (tool.events.length > EVENT_HISTORY) tool.events.shift();
          },
          alarm: (a) => this.route(tool, topics.alarm(eqpId), "alarm", link.alarm(a, this.now())),
          state: (s) => this.route(tool, topics.state(eqpId), "state", s),
          link: (controlState) => {
            const payload = { eqpId, online: controlState !== "OFFLINE", controlState };
            // The host notices link changes on its side of the wire, online or not.
            this.bus.publish(topics.link(eqpId), "link", "HOST-LINK", payload, this.now());
            this.local(topics.link(eqpId), "link", eqpId, payload);
          },
          metrology: (m) => {
            // Metrology comes from a separate measurement tool, not this tool's host link.
            this.bus.publish(topics.metrology(eqpId), "metrology", "METROLOGY", m, this.now());
            this.local(topics.metrology(eqpId), "metrology", "METROLOGY", m);
          },
        },
      },
      this.now(),
    );
    this.tools.set(cfg.id, tool);
    this.publishInfo(cfg.id);
  }

  updateEquipment(cfg: EquipmentConfig) {
    const tool = this.tools.get(cfg.id);
    if (!tool) throw new Error(`Unknown equipment ${cfg.id}`);
    tool.eq.reconfigure(cfg);
    tool.link.reconfigure(cfg);
    this.publishInfo(cfg.id);
  }

  removeEquipment(id: string) {
    const cfg = this.config(id);
    this.tools.delete(id);
    this.faults = this.faults.filter((f) => f.eqpId !== id);
    this.indexFaults();
    if (cfg) this.bus.publish(topics.info(id), "info", "MASTER-DATA", { ...infoOf(cfg), removed: true }, this.now());
  }

  /** Equipment master data sync to the systems (all tools when no id is given). */
  publishInfo(id?: string) {
    const ids = id ? [id] : [...this.tools.keys()];
    for (const eqpId of ids) {
      const cfg = this.config(eqpId);
      if (cfg) this.bus.publish(topics.info(eqpId), "info", "MASTER-DATA", infoOf(cfg), this.now());
    }
  }

  statuses(): EquipmentStatus[] {
    return [...this.tools.values()].map((t) => t.eq.status());
  }

  statusOf(id: string): EquipmentStatus | undefined {
    return this.tools.get(id)?.eq.status();
  }

  link(id: string): VendorLink | undefined {
    return this.tools.get(id)?.link;
  }

  events(id: string, limit = 100): Envelope<EventPayload>[] {
    return (this.tools.get(id)?.events ?? []).slice(-limit);
  }

  command(eqpId: string, cmd: Omit<CommandPayload, "eqpId"> & { eqpId?: string }): CommandResult {
    const tool = this.tools.get(eqpId);
    if (!tool) return { ok: false, message: `Unknown equipment ${eqpId}` };
    const full: CommandPayload = { ...cmd, eqpId };
    const result = tool.eq.command(full);
    if (full.origin === "HOST") tool.link.command(full, result, this.now());
    return result;
  }

  private route<T>(tool: Tool, topic: string, kind: MessageKind, payload: T): Envelope<T> {
    const env = this.local(topic, kind, tool.eq.cfg.id, payload);
    if (tool.eq.controlState !== "OFFLINE") this.bus.publish(topic, kind, tool.eq.cfg.id, payload, this.now());
    return env;
  }

  private local<T>(topic: string, kind: MessageKind, source: string, payload: T): Envelope<T> {
    const env: Envelope<T> = { id: ++this.localSeq, topic, kind, ts: this.now(), source, payload };
    for (const l of this.listeners) l(env);
    return env;
  }

  onLocal(listener: LocalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------- faults

  listFaults(): FaultInjection[] {
    return this.faults.map((f) => ({ ...f }));
  }

  addFault(input: Omit<FaultInjection, "id" | "startedAt"> & { id?: string }): FaultInjection {
    const fault: FaultInjection = { ...input, id: `F${String(++this.faultSeq).padStart(3, "0")}`, startedAt: this.now() };
    this.faults.push(fault);
    this.indexFaults();
    return fault;
  }

  updateFault(id: string, patch: Partial<FaultInjection>): FaultInjection | undefined {
    const f = this.faults.find((x) => x.id === id);
    if (!f) return undefined;
    const wasEnabled = f.enabled;
    Object.assign(f, patch, { id: f.id });
    if (!wasEnabled && f.enabled) f.startedAt = this.now();
    this.indexFaults();
    return { ...f };
  }

  removeFault(id: string): boolean {
    const before = this.faults.length;
    this.faults = this.faults.filter((f) => f.id !== id);
    this.indexFaults();
    return this.faults.length !== before;
  }

  private expireFaults() {
    const now = this.now();
    const expired = this.faults.filter((f) => f.enabled && f.durationSec > 0 && now - f.startedAt >= f.durationSec * 1000);
    if (!expired.length) return;
    for (const f of expired) f.enabled = false;
    this.indexFaults();
  }

  private indexFaults() {
    this.faultIndex.clear();
    for (const f of this.faults) {
      if (!f.enabled) continue;
      const cfg = this.config(f.eqpId);
      if (!cfg) continue;
      const chambers = f.chamberId === "*" ? cfg.chambers : [f.chamberId];
      for (const ch of chambers) {
        const key = `${f.eqpId}|${ch}`;
        const list = this.faultIndex.get(key) ?? [];
        list.push(f);
        this.faultIndex.set(key, list);
      }
    }
  }
}

export function infoOf(cfg: EquipmentConfig): EquipmentInfoPayload {
  return {
    eqpId: cfg.id,
    name: cfg.name,
    type: cfg.type,
    vendor: cfg.vendor,
    model: cfg.model,
    area: cfg.area,
    chambers: [...cfg.chambers],
    processMode: cfg.processMode,
    parameters: cfg.parameters.map(({ key, name, unit, tolerance, min, max }) => ({ key, name, unit, tolerance, min, max })),
    recipes: cfg.recipes.map((r) => ({ id: r.id, name: r.name, steps: r.steps.map((st) => ({ name: st.name, duration: st.duration })) })),
    metrology: cfg.metrology.map(({ key, name, unit, target, usl, lsl }) => ({ key, name, unit, target, usl, lsl })),
  };
}
