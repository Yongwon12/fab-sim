import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FabApp } from "./app";

let app: FabApp;

const call = async (method: string, path: string, body?: unknown) => app.dispatch(method, path, body) as Promise<{ status: number; data: any }>;

beforeAll(() => {
  app = new FabApp({ scenarioFile: null, autostart: false });
});

afterAll(() => {
  app.stop();
});

describe("app API (IPC dispatch)", () => {
  it("bootstraps the default mixed-vendor fab", async () => {
    const { status, data } = await call("GET", "/api/bootstrap");
    expect(status).toBe(200);
    expect(data.equipment.length).toBe(6);
    expect(new Set(data.equipment.map((e: { vendor: string }) => e.vendor))).toEqual(new Set(["VA", "VB", "VC"]));
    expect(data.vendors).toHaveLength(3);
  });

  it("creates equipment, validates input and runs commands", async () => {
    expect((await call("POST", "/api/equipment", { id: "bad id!", type: "ETCH", vendor: "VA" })).status).toBe(400);
    const created = await call("POST", "/api/equipment", { id: "PVD-09", type: "PVD", vendor: "VC", chambers: ["CH1", "CH2", "CH3"] });
    expect(created.status).toBe(200);
    expect(created.data.chambers).toEqual(["CH1", "CH2", "CH3"]);
    expect((await call("POST", "/api/equipment", { id: "PVD-09", type: "PVD", vendor: "VC" })).status).toBe(409);
    const cmd = await call("POST", "/api/equipment/PVD-09/command", { action: "LOAD_CARRIER", args: { wafers: 3 } });
    expect(cmd.data.ok).toBe(true);
    app.sim.runFor(60_000);
    const detail = await call("GET", "/api/equipment/PVD-09");
    expect(detail.data.mappings.length).toBe(3 * detail.data.config.parameters.length);
    const frames = await call("GET", "/api/equipment/PVD-09/frames?kind=trace");
    expect(frames.data.length).toBeGreaterThan(0);
    expect(frames.data[0].protocol).toContain("OPC UA");
  });

  it("rejects an invalid recipe edit and accepts a valid one", async () => {
    const { data: cfg } = await call("GET", "/api/equipment/ETCH-01");
    const bad = structuredClone(cfg.config);
    bad.recipes[0].steps[0].setpoints.not_a_param = 1;
    expect((await call("PUT", "/api/equipment/ETCH-01", bad)).status).toBe(400);
    const good = structuredClone(cfg.config);
    good.recipes[0].steps[0].duration = 12;
    good.generation.traceIntervalMs = 500;
    const res = await call("PUT", "/api/equipment/ETCH-01", good);
    expect(res.status).toBe(200);
    expect(app.sim.config("ETCH-01")!.generation.traceIntervalMs).toBe(500);
  });

  it("manages faults, routes and the scenario round trip", async () => {
    const f = await call("POST", "/api/faults", { eqpId: "ETCH-02", chamberId: "PM1", param: "gas_cf4", type: "DRIFT", magnitude: 2 });
    expect(f.status).toBe(200);
    expect((await call("POST", "/api/faults", { eqpId: "ETCH-02", param: "nope", type: "SHIFT" })).status).toBe(400);
    expect((await call("PATCH", "/api/bus/routes", { subscriber: "FDC", pattern: "eqp/+/trace/+", enabled: false })).status).toBe(200);
    const scenario = (await call("GET", "/api/scenario")).data;
    expect(scenario.faults).toHaveLength(1);
    expect(scenario.disabledRoutes).toEqual([{ subscriber: "FDC", pattern: "eqp/+/trace/+" }]);
    expect((await call("POST", "/api/scenario/reset")).status).toBe(200);
    expect((await call("GET", "/api/faults")).data).toHaveLength(0);
    expect((await call("PUT", "/api/scenario", scenario)).status).toBe(200);
    expect((await call("GET", "/api/faults")).data).toHaveLength(1);
    expect(app.bus.routes().find((r) => r.subscriber === "FDC" && r.pattern === "eqp/+/trace/+")!.enabled).toBe(false);
    expect((await call("PUT", "/api/scenario", { version: 2 })).status).toBe(400);
  });

  it("serves exports and system endpoints", async () => {
    await call("PATCH", "/api/bus/routes", { subscriber: "FDC", pattern: "eqp/+/trace/+", enabled: true });
    app.sim.runFor(10 * 60_000);
    const csv = app.exportFile("/api/export/events.csv?eqpId=ETCH-01");
    expect(csv.name).toBe("erd-events-ETCH-01.csv");
    expect(csv.body.split("\n")[0]).toContain("timestamp,eqp_id,event");
    for (const p of ["/api/ees/overview", "/api/fdc/summary", "/api/qms/summary", "/api/ams/stats", "/api/bus"]) {
      expect((await call("GET", p)).status, p).toBe(200);
    }
    const runs = (await call("GET", "/api/fdc/runs?limit=5")).data;
    expect(runs.length).toBeGreaterThan(0);
    const trace = app.exportFile(`/api/fdc/runs/${runs[0].runId}/csv`);
    expect(trace.body).toContain("run_id");
    expect(() => app.exportFile("/api/fdc/runs/nope/csv")).toThrow();
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });
});

describe("live session", () => {
  it("pushes status and only the subscribed topics", () => {
    const pushed: Array<{ type: string; messages?: Array<{ topic: string }> }> = [];
    const session = app.openSession((m) => pushed.push(m as (typeof pushed)[number]));
    expect(pushed[0].type).toBe("status");
    session.subscribe(["eqp/ETCH-01/event"]);
    app.sim.runFor(120_000);
    return new Promise<void>((resolve) => setTimeout(resolve, 300)).then(() => {
      session.close();
      const topics = pushed.filter((m) => m.type === "messages").flatMap((m) => m.messages!.map((x) => x.topic));
      expect(topics.length).toBeGreaterThan(0);
      expect(new Set(topics)).toEqual(new Set(["eqp/ETCH-01/event"]));
    });
  });
});

