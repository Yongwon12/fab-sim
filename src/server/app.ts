import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { CommandAction, CommandPayload, Envelope, FaultInjection, VendorId, EquipmentType } from "../shared/types";
import { EVENT_NAMES } from "../shared/types";
import { topicMatches, topics } from "../shared/topics";
import { MessageBus } from "./bus/message-bus";
import { Simulator } from "./simulator/simulator";
import { createEquipmentFromTemplate, defaultFab, templateInfo, suggestedLotInterval } from "./simulator/templates";
import { VENDORS } from "./simulator/vendors";
import { FdcSystem, DEFAULT_FDC_CONFIG } from "./systems/fdc";
import { EesSystem, DEFAULT_EES_CONFIG } from "./systems/ees";
import { QmsSystem, DEFAULT_QMS_CONFIG, RULE_TEXT } from "./systems/qms";
import { AmsSystem, DEFAULT_AMS_CONFIG } from "./systems/ams";
import type { Scenario } from "./scenario";
import { normalizeEquipment, validateEquipment } from "./scenario";

export interface AppOptions {
  /** Where the scenario is saved; null = no persistence. */
  scenarioFile: string | null;
  seed?: number;
  autostart?: boolean;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string>;
type Query = URLSearchParams;
type RouteHandler = (ctx: { params: Params; query: Query; body: any }) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: RouteHandler;
}

const COMMAND_ACTIONS: CommandAction[] = [
  "ONLINE_REMOTE",
  "ONLINE_LOCAL",
  "OFFLINE",
  "LOAD_CARRIER",
  "START_LOT",
  "UNLOAD_CARRIER",
  "PAUSE",
  "RESUME",
  "ABORT",
  "ALARM_RESET",
  "RAISE_ALARM",
  "PM_START",
  "PM_END",
  "SET_MODE",
  "HOLD",
  "RELEASE_HOLD",
];

/** Kinds the UI gets from the bus; equipment data comes from the local feed instead. */
const BUS_TO_UI = new Set(["command", "info", "fdc.alarm", "fdc.run", "qms.alarm", "qms.lot", "ees.alarm", "ams.alarm", "ams.notify"]);

export class FabApp {
  readonly bus = new MessageBus();
  readonly fdc: FdcSystem;
  readonly ees: EesSystem;
  readonly qms: QmsSystem;
  readonly ams: AmsSystem;
  readonly sim: Simulator;
  private routes: Route[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private systemTimer: ReturnType<typeof setInterval> | null = null;
  private wss: WebSocketServer | null = null;

  constructor(private opts: AppOptions) {
    // Systems subscribe first so they see the master data the simulator publishes on load.
    this.fdc = new FdcSystem(this.bus);
    this.ees = new EesSystem(this.bus);
    this.qms = new QmsSystem(this.bus);
    this.ams = new AmsSystem(this.bus);
    this.sim = new Simulator(this.bus, { seed: opts.seed });
    const scenario = this.readScenario();
    try {
      this.applyScenario(scenario ?? this.defaultScenario(), false);
    } catch (err) {
      console.warn(`[fab-sim] saved scenario rejected (${(err as Error).message}); starting from the default fab`);
      this.applyScenario(this.defaultScenario(), false);
    }
    this.defineRoutes();
  }

  get systems() {
    return [this.fdc, this.ees, this.qms, this.ams];
  }

  start() {
    if (this.opts.autostart !== false) this.sim.start();
    this.systemTimer = setInterval(() => {
      const now = this.sim.now();
      for (const s of this.systems) s.tick(now);
    }, 250);
  }

  stop() {
    this.sim.pause();
    if (this.systemTimer) clearInterval(this.systemTimer);
    this.wss?.close();
    this.flushSave();
  }

  // --------------------------------------------------------- scenario

  defaultScenario(): Scenario {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      sim: { seed: this.opts.seed ?? 20261014, speed: 1 },
      equipment: defaultFab(),
      faults: [],
      systems: {
        fdc: { ...DEFAULT_FDC_CONFIG },
        ees: { ...DEFAULT_EES_CONFIG },
        qms: structuredClone(DEFAULT_QMS_CONFIG),
        qmsSpecs: {},
        ams: structuredClone(DEFAULT_AMS_CONFIG),
      },
      disabledRoutes: [],
    };
  }

  scenario(): Scenario {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      sim: { seed: this.sim.status.seed, speed: this.sim.status.speed },
      equipment: this.sim.configs(),
      faults: this.sim.listFaults(),
      systems: {
        fdc: this.fdc.config,
        ees: this.ees.config,
        qms: this.qms.config,
        qmsSpecs: this.qms.specOverridesList(),
        ams: this.ams.config,
      },
      disabledRoutes: this.bus.routes().filter((r) => !r.enabled).map(({ subscriber, pattern }) => ({ subscriber, pattern })),
    };
  }

  applyScenario(s: Scenario, resetRuntime = true) {
    if (!s || s.version !== 1 || !Array.isArray(s.equipment)) throw new HttpError(400, "Not a fab-sim scenario (version 1)");
    const equipment = s.equipment.map((e) => normalizeEquipment(e));
    const ids = new Set<string>();
    for (const e of equipment) {
      const errors = validateEquipment(e);
      if (errors.length) throw new HttpError(400, `${e.id}: ${errors.join("; ")}`);
      if (ids.has(e.id)) throw new HttpError(400, `Duplicate equipment id ${e.id}`);
      ids.add(e.id);
    }
    if (resetRuntime) for (const sys of this.systems) sys.reset();
    this.fdc.setConfig({ ...DEFAULT_FDC_CONFIG, ...(s.systems?.fdc ?? {}) });
    this.ees.setConfig({ ...DEFAULT_EES_CONFIG, ...(s.systems?.ees ?? {}) });
    this.qms.setConfig({ ...structuredClone(DEFAULT_QMS_CONFIG), ...(s.systems?.qms ?? {}) });
    this.qms.loadSpecOverrides(s.systems?.qmsSpecs ?? {});
    this.ams.setConfig({ ...structuredClone(DEFAULT_AMS_CONFIG), ...(s.systems?.ams ?? {}) });
    for (const r of this.bus.routes()) this.bus.setRouteEnabled(r.subscriber, r.pattern, true);
    for (const r of s.disabledRoutes ?? []) this.bus.setRouteEnabled(r.subscriber, r.pattern, false);
    this.sim.setSpeed(s.sim?.speed ?? 1);
    const faults = (s.faults ?? []).filter((f) => ids.has(f.eqpId));
    this.bus.resetStats();
    if (resetRuntime) this.sim.reset(equipment, faults, s.sim?.seed);
    else this.sim.load(equipment, faults);
    this.scheduleSave();
  }

  private readScenario(): Scenario | null {
    const file = this.opts.scenarioFile;
    if (!file || !existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Scenario;
    } catch (err) {
      console.warn(`[fab-sim] ignoring unreadable scenario ${file}:`, err);
      return null;
    }
  }

  scheduleSave() {
    if (!this.opts.scenarioFile) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 800);
  }

  private flushSave() {
    const file = this.opts.scenarioFile;
    if (!file || !this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.scenario(), null, 2));
    renameSync(tmp, file);
  }

  // ------------------------------------------------------------ routes

  private route(method: string, path: string, handler: RouteHandler) {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
  }

  private defineRoutes() {
    const r = this.route.bind(this);
    const sim = this.sim;
    const now = () => sim.now();
    const eqp = (id: string) => {
      const cfg = sim.config(id);
      if (!cfg) throw new HttpError(404, `Unknown equipment ${id}`);
      return cfg;
    };
    const str = (q: Query, k: string) => q.get(k) || undefined;
    const int = (q: Query, k: string, d: number) => {
      const v = Number(q.get(k));
      return Number.isFinite(v) && v > 0 ? Math.min(v, 5000) : d;
    };

    r("GET", "/api/bootstrap", () => ({
      sim: sim.status,
      vendors: Object.values(VENDORS),
      templates: templateInfo(),
      eventNames: EVENT_NAMES,
      commandActions: COMMAND_ACTIONS,
      spcRules: RULE_TEXT,
      equipment: sim.configs(),
      status: sim.statuses(),
      faults: sim.listFaults(),
    }));

    // ---- simulation
    r("GET", "/api/sim", () => sim.status);
    r("POST", "/api/sim", ({ body }) => {
      if (body.speed !== undefined) {
        sim.setSpeed(Number(body.speed));
        this.scheduleSave();
      }
      switch (body.action) {
        case "start":
          sim.start();
          break;
        case "pause":
          sim.pause();
          break;
        case "reset": {
          const s = this.scenario();
          if (body.seed !== undefined) s.sim.seed = Number(body.seed);
          this.applyScenario(s, true);
          break;
        }
      }
      return sim.status;
    });

    // ---- equipment
    r("GET", "/api/equipment/:id", ({ params }) => {
      const cfg = eqp(params.id);
      const link = sim.link(cfg.id)!;
      return { config: cfg, status: sim.statusOf(cfg.id), mappings: link.mappings, vendor: VENDORS[cfg.vendor] };
    });
    r("POST", "/api/equipment", ({ body }) => {
      const id = String(body.id ?? "").trim();
      if (sim.has(id)) throw new HttpError(409, `Equipment ${id} already exists`);
      const cfg = createEquipmentFromTemplate({
        id,
        type: body.type as EquipmentType,
        vendor: body.vendor as VendorId,
        name: body.name ? String(body.name) : undefined,
        chambers: Array.isArray(body.chambers) ? body.chambers.map(String) : undefined,
        loadPorts: body.loadPorts ? Number(body.loadPorts) : undefined,
      });
      if (Array.isArray(body.chambers) && body.chambers.length) cfg.generation.lotIntervalSec = suggestedLotInterval(cfg);
      const errors = validateEquipment(cfg);
      if (errors.length) throw new HttpError(400, errors.join("; "));
      sim.addEquipment(cfg);
      this.scheduleSave();
      return cfg;
    });
    r("PUT", "/api/equipment/:id", ({ params, body }) => {
      const current = eqp(params.id);
      const cfg = normalizeEquipment({ ...body, id: current.id, type: current.type, vendor: body.vendor ?? current.vendor });
      const errors = validateEquipment(cfg);
      if (errors.length) throw new HttpError(400, errors.join("; "));
      sim.updateEquipment(cfg);
      this.scheduleSave();
      return cfg;
    });
    r("DELETE", "/api/equipment/:id", ({ params }) => {
      eqp(params.id);
      sim.removeEquipment(params.id);
      this.scheduleSave();
      return { ok: true };
    });
    r("POST", "/api/equipment/:id/command", ({ params, body }) => {
      eqp(params.id);
      const action = String(body.action) as CommandAction;
      if (!COMMAND_ACTIONS.includes(action)) throw new HttpError(400, `Unknown action ${action}`);
      return sim.command(params.id, { action, args: body.args ?? {}, origin: "LOCAL", requestedBy: "OPERATOR" });
    });
    // Send a command the way a host system would: over the bus, needs ONLINE_REMOTE.
    r("POST", "/api/equipment/:id/host-command", ({ params, body }) => {
      eqp(params.id);
      const action = String(body.action) as CommandAction;
      if (!COMMAND_ACTIONS.includes(action)) throw new HttpError(400, `Unknown action ${action}`);
      const cmd: CommandPayload = { eqpId: params.id, action, args: body.args ?? {}, origin: "HOST", requestedBy: "HOST-UI" };
      this.bus.publish(topics.command(params.id), "command", "HOST-UI", cmd, now());
      const last = sim.link(params.id)!.frames().filter((f) => f.kind === "command").pop();
      return { ok: true, message: last?.summary ?? "sent" };
    });
    r("GET", "/api/equipment/:id/frames", ({ params, query }) => {
      eqp(params.id);
      const kind = str(query, "kind");
      return sim
        .link(params.id)!
        .frames()
        .filter((f) => !kind || f.kind === kind)
        .slice(-int(query, "limit", 80))
        .reverse();
    });
    r("GET", "/api/equipment/:id/events", ({ params, query }) => {
      eqp(params.id);
      return sim.events(params.id, int(query, "limit", 100)).reverse();
    });

    // ---- faults
    r("GET", "/api/faults", () => sim.listFaults());
    r("POST", "/api/faults", ({ body }) => {
      const cfg = eqp(String(body.eqpId));
      const param = String(body.param);
      if (!cfg.parameters.some((p) => p.key === param)) throw new HttpError(400, `Unknown parameter ${param}`);
      const chamberId = String(body.chamberId ?? "*");
      if (chamberId !== "*" && !cfg.chambers.includes(chamberId)) throw new HttpError(400, `Unknown chamber ${chamberId}`);
      const type = String(body.type) as FaultInjection["type"];
      if (!["SHIFT", "DRIFT", "SPIKE", "NOISE", "STUCK", "DROPOUT"].includes(type)) throw new HttpError(400, "Unknown fault type");
      const f = sim.addFault({
        eqpId: cfg.id,
        chamberId,
        param,
        type,
        magnitude: Number(body.magnitude ?? 0),
        probability: Math.min(1, Math.max(0, Number(body.probability ?? 0.1))),
        processOnly: body.processOnly !== false,
        enabled: body.enabled !== false,
        durationSec: Math.max(0, Number(body.durationSec ?? 0)),
        note: body.note ? String(body.note) : undefined,
      });
      this.scheduleSave();
      return f;
    });
    r("PATCH", "/api/faults/:id", ({ params, body }) => {
      const patch: Partial<FaultInjection> = {};
      for (const k of ["magnitude", "probability", "durationSec"] as const) if (body[k] !== undefined) patch[k] = Number(body[k]);
      for (const k of ["enabled", "processOnly"] as const) if (body[k] !== undefined) patch[k] = Boolean(body[k]);
      if (body.note !== undefined) patch.note = String(body.note);
      const f = sim.updateFault(params.id, patch);
      if (!f) throw new HttpError(404, "Unknown fault");
      this.scheduleSave();
      return f;
    });
    r("DELETE", "/api/faults/:id", ({ params }) => {
      if (!sim.removeFault(params.id)) throw new HttpError(404, "Unknown fault");
      this.scheduleSave();
      return { ok: true };
    });

    // ---- bus
    r("GET", "/api/bus", ({ query }) => ({
      stats: this.bus.getStats(),
      routes: this.bus.routes(),
      recent: this.bus.recent(int(query, "limit", 120)).reverse(),
    }));
    r("PATCH", "/api/bus/routes", ({ body }) => {
      if (body.subscriber === "EQUIPMENT") throw new HttpError(400, "The equipment command route cannot be switched off");
      if (!this.bus.setRouteEnabled(String(body.subscriber), String(body.pattern), Boolean(body.enabled))) throw new HttpError(404, "Unknown route");
      this.scheduleSave();
      return this.bus.routes();
    });

    // ---- EES
    r("GET", "/api/ees/overview", () => ({ overview: this.ees.overview(now()), eventCounts: this.ees.eventCounts() }));
    r("GET", "/api/ees/equipment/:id", ({ params, query }) => {
      eqp(params.id);
      const hours = Number(query.get("hours") ?? 1);
      return {
        kpis: this.ees.kpis(params.id, now()),
        timeline: this.ees.timeline(params.id, now() - Math.max(0.05, hours) * 3_600_000),
        now: now(),
      };
    });
    r("GET", "/api/ees/events", ({ query }) =>
      this.ees.listEvents({ eqpId: str(query, "eqpId"), name: str(query, "name"), lotId: str(query, "lotId"), limit: int(query, "limit", 200) }),
    );
    r("GET", "/api/ees/lots", ({ query }) => this.ees.listLots({ eqpId: str(query, "eqpId"), limit: int(query, "limit", 200) }));
    r("GET", "/api/ees/config", () => this.ees.config);
    r("PUT", "/api/ees/config", ({ body }) => {
      const c = this.ees.setConfig(pickNumbers(body, ["udtAlertSec", "kpiWindowHours"]));
      this.scheduleSave();
      return c;
    });

    // ---- FDC
    r("GET", "/api/fdc/summary", () => this.fdc.summary());
    r("GET", "/api/fdc/runs", ({ query }) =>
      this.fdc.listRuns({ eqpId: str(query, "eqpId"), chamberId: str(query, "chamberId"), recipeId: str(query, "recipeId"), limit: int(query, "limit", 100) }),
    );
    r("GET", "/api/fdc/runs/:runId", ({ params }) => {
      const run = this.fdc.getRun(params.runId);
      if (!run) throw new HttpError(404, "Unknown run (only the latest runs per chamber are kept)");
      return run;
    });
    r("GET", "/api/fdc/faults", ({ query }) => this.fdc.listFaults({ eqpId: str(query, "eqpId"), limit: int(query, "limit", 200) }));
    r("GET", "/api/fdc/models", ({ query }) =>
      this.fdc.listModels({
        eqpId: str(query, "eqpId"),
        chamberId: str(query, "chamberId"),
        recipeId: str(query, "recipeId"),
        param: str(query, "param"),
        stat: str(query, "stat"),
      }),
    );
    r("GET", "/api/fdc/trend", ({ query }) => {
      const t = this.fdc.trend(String(query.get("key")));
      if (!t) throw new HttpError(404, "Unknown model");
      return t;
    });
    r("PATCH", "/api/fdc/models", ({ body }) => {
      try {
        const t = this.fdc.updateModel(String(body.key), {
          lcl: body.lcl === undefined ? undefined : Number(body.lcl),
          ucl: body.ucl === undefined ? undefined : Number(body.ucl),
          state: body.state,
        });
        if (!t) throw new HttpError(404, "Unknown model");
        return t;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, (err as Error).message);
      }
    });
    r("POST", "/api/fdc/relearn", ({ body }) => ({ models: this.fdc.relearn({ eqpId: body.eqpId, chamberId: body.chamberId, recipeId: body.recipeId }) }));
    r("GET", "/api/fdc/config", () => this.fdc.config);
    r("PUT", "/api/fdc/config", ({ body }) => {
      const patch: Record<string, unknown> = pickNumbers(body, [
        "baselineRuns",
        "sigmaK",
        "minWidthFactor",
        "trimSec",
        "settleFactor",
        "settleMaxSec",
        "minSamples",
        "realtimeFactor",
        "criticalFactor",
        "driftRuns",
      ]);
      if (body.realtime !== undefined) patch.realtime = Boolean(body.realtime);
      if (["OFF", "CRITICAL", "ALL"].includes(body.interlock)) patch.interlock = body.interlock;
      const c = this.fdc.setConfig(patch);
      this.scheduleSave();
      return c;
    });

    // ---- QMS
    r("GET", "/api/qms/summary", () => this.qms.summary());
    r("GET", "/api/qms/charts", ({ query }) => this.qms.listCharts({ eqpId: str(query, "eqpId") }));
    r("GET", "/api/qms/chart", ({ query }) => {
      const c = this.qms.getChart(String(query.get("key")), int(query, "limit", 200));
      if (!c) throw new HttpError(404, "Unknown chart");
      return c;
    });
    r("PATCH", "/api/qms/chart", ({ body }) => {
      try {
        const nul = (v: unknown) => (v === null || v === "" ? null : v === undefined ? undefined : Number(v));
        const c = this.qms.updateChart(String(body.key), {
          target: body.target === undefined ? undefined : Number(body.target),
          usl: nul(body.usl),
          lsl: nul(body.lsl),
          cl: body.cl === undefined ? undefined : Number(body.cl),
          ucl: body.ucl === undefined ? undefined : Number(body.ucl),
          lcl: body.lcl === undefined ? undefined : Number(body.lcl),
          relearn: Boolean(body.relearn),
        });
        if (!c) throw new HttpError(404, "Unknown chart");
        this.scheduleSave();
        return c;
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, (err as Error).message);
      }
    });
    r("GET", "/api/qms/lots", ({ query }) => this.qms.listLots({ eqpId: str(query, "eqpId"), status: str(query, "status"), limit: int(query, "limit", 200) }));
    r("POST", "/api/qms/lots/:lotId/disposition", ({ params, body }) => {
      const status = String(body.status);
      if (!["RELEASED", "SCRAPPED", "REWORK"].includes(status)) throw new HttpError(400, "status: RELEASED, SCRAPPED or REWORK");
      try {
        return this.qms.disposition(params.lotId, status as "RELEASED", String(body.by ?? "QE"), now(), body.note ? String(body.note) : "");
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    });
    r("GET", "/api/qms/config", () => this.qms.config);
    r("PUT", "/api/qms/config", ({ body }) => {
      const patch: Record<string, unknown> = pickNumbers(body, ["baselinePoints", "inhibitAfterOosLots"]);
      if (body.holdOnOos !== undefined) patch.holdOnOos = Boolean(body.holdOnOos);
      if (body.rules && typeof body.rules === "object") patch.rules = body.rules;
      const c = this.qms.setConfig(patch);
      this.scheduleSave();
      return c;
    });

    // ---- AMS
    r("GET", "/api/ams/alarms", ({ query }) =>
      this.ams.listAlarms({
        state: str(query, "state"),
        source: str(query, "source"),
        eqpId: str(query, "eqpId"),
        openOnly: query.get("open") === "1",
        limit: int(query, "limit", 300),
      }),
    );
    r("POST", "/api/ams/alarms/:id/ack", ({ params, body }) => this.wrap(() => this.ams.ack(Number(params.id), String(body.by ?? "operator"), now())));
    r("POST", "/api/ams/alarms/:id/close", ({ params, body }) => this.wrap(() => this.ams.closeAlarm(Number(params.id), String(body.by ?? "operator"), now())));
    r("POST", "/api/ams/ack-all", ({ body }) => ({ acked: this.ams.ackAll({ eqpId: body.eqpId, source: body.source }, String(body.by ?? "operator"), now()) }));
    r("POST", "/api/ams/shelve", ({ body }) => this.ams.shelve(String(body.eqpId ?? "*"), String(body.code), Number(body.minutes ?? 30), String(body.by ?? "operator"), now()));
    r("GET", "/api/ams/shelves", () => this.ams.listShelves(now()));
    r("GET", "/api/ams/notifications", ({ query }) => this.ams.listNotifications(int(query, "limit", 200)));
    r("GET", "/api/ams/stats", () => this.ams.stats());
    r("GET", "/api/ams/config", () => this.ams.config);
    r("PUT", "/api/ams/config", ({ body }) => {
      const patch: Record<string, unknown> = pickNumbers(body, ["floodThreshold", "floodWindowSec"]);
      if (Array.isArray(body.rules)) patch.rules = body.rules;
      if (Array.isArray(body.groups)) patch.groups = body.groups;
      if (Array.isArray(body.escalation)) patch.escalation = body.escalation;
      if (body.escalationMinSeverity) patch.escalationMinSeverity = body.escalationMinSeverity;
      const c = this.ams.setConfig(patch);
      this.scheduleSave();
      return c;
    });

    // ---- scenario & data
    r("GET", "/api/scenario", () => this.scenario());
    r("PUT", "/api/scenario", ({ body }) => {
      this.applyScenario(body as Scenario, true);
      return { ok: true };
    });
    r("POST", "/api/scenario/reset", () => {
      this.applyScenario(this.defaultScenario(), true);
      return { ok: true };
    });
    r("POST", "/api/systems/reset", () => {
      for (const s of this.systems) s.reset();
      this.bus.resetStats();
      return { ok: true };
    });
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  /** Text exports that are not JSON. */
  private exportText(path: string, query: Query): { type: string; name: string; body: string } | null {
    const m = path.match(/^\/api\/fdc\/runs\/([^/]+)\/csv$/);
    if (m) {
      const csv = this.fdc.runCsv(decodeURIComponent(m[1]));
      if (!csv) throw new HttpError(404, "Unknown run");
      return { type: "text/csv", name: `${decodeURIComponent(m[1])}.csv`, body: csv };
    }
    if (path === "/api/export/events.csv") {
      const events = this.ees.listEvents({ eqpId: query.get("eqpId") || undefined, limit: 5000 }).reverse();
      const rows = events.map((e) =>
        [new Date(e.ts).toISOString(), e.eqpId, e.name, e.ceid, e.chamberId ?? "", csvCell(JSON.stringify(e.values)), csvCell(JSON.stringify(e.extra ?? {}))].join(","),
      );
      return { type: "text/csv", name: "erd-events.csv", body: ["timestamp,eqp_id,event,ceid,chamber_id,report,extra_report", ...rows].join("\n") };
    }
    if (path === "/api/export/scenario.json") {
      return { type: "application/json", name: "fab-sim-scenario.json", body: JSON.stringify(this.scenario(), null, 2) };
    }
    return null;
  }

  /** Returns false when the request is not an API call (static files take it). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (req.method === "GET") {
        const text = this.exportText(url.pathname, url.searchParams);
        if (text) {
          res.writeHead(200, {
            "Content-Type": `${text.type}; charset=utf-8`,
            "Content-Disposition": `attachment; filename="${text.name}"`,
          });
          res.end(text.body);
          return true;
        }
      }
      const parts = url.pathname.split("/").filter(Boolean);
      for (const route of this.routes) {
        if (route.method !== req.method || route.parts.length !== parts.length) continue;
        const params: Params = {};
        const ok = route.parts.every((p, i) => {
          if (p.startsWith(":")) {
            params[p.slice(1)] = decodeURIComponent(parts[i]);
            return true;
          }
          return p === parts[i];
        });
        if (!ok) continue;
        const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
        const result = await route.handler({ params, query: url.searchParams, body });
        sendJson(res, 200, result ?? { ok: true });
        return true;
      }
      throw new HttpError(404, `No route ${req.method} ${url.pathname}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[fab-sim]", err);
      sendJson(res, status, { error: (err as Error).message });
      return true;
    }
  }

  // ---------------------------------------------------------- websocket

  attachWebSocket(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.wss = wss;
    server.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return;
      wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws));
    });
  }

  private onClient(ws: WebSocket) {
    let patterns: string[] = [];
    let queue: Envelope[] = [];
    let dropped = 0;
    const MAX_QUEUE = 1500;
    const enqueue = (msg: Envelope) => {
      if (!patterns.some((p) => topicMatches(p, msg.topic))) return;
      queue.push(msg);
      if (queue.length > MAX_QUEUE) {
        dropped += queue.length - MAX_QUEUE;
        queue = queue.slice(-MAX_QUEUE);
      }
    };
    const offLocal = this.sim.onLocal(enqueue);
    const offBus = this.bus.tap((msg) => {
      if (BUS_TO_UI.has(msg.kind)) enqueue(msg);
    });
    const send = (data: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
    };
    const flush = setInterval(() => {
      if (!queue.length && !dropped) return;
      send({ type: "messages", messages: queue, dropped });
      queue = [];
      dropped = 0;
    }, 200);
    const status = setInterval(() => {
      const ams = this.ams.stats();
      send({
        type: "status",
        sim: this.sim.status,
        status: this.sim.statuses(),
        alarms: { active: ams.active, critical: ams.criticalOpen, unacked: ams.active + ams.clearedUnacked },
      });
    }, 500);
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "subscribe" && Array.isArray(msg.topics)) patterns = msg.topics.map(String).slice(0, 50);
      } catch {
        // ignore malformed client messages
      }
    });
    ws.on("close", () => {
      offLocal();
      offBus();
      clearInterval(flush);
      clearInterval(status);
    });
    send({ type: "hello", sim: this.sim.status });
  }
}

function pickNumbers(body: Record<string, unknown>, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (body[k] === undefined) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v)) throw new HttpError(400, `${k} must be a number`);
    out[k] = v;
  }
  return out;
}

function csvCell(s: string) {
  return `"${s.replace(/"/g, '""')}"`;
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

