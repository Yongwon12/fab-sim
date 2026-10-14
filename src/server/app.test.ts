import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FabApp } from "./app";

let app: FabApp;
let server: Server;
let base = "";

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
};

beforeAll(async () => {
  app = new FabApp({ scenarioFile: null, autostart: false });
  server = createServer(async (req, res) => {
    if (!(await app.handle(req, res))) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  app.stop();
  server.close();
});

describe("REST API", () => {
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
    const csv = await call("GET", "/api/export/events.csv");
    expect(String(csv.data).split("\n")[0]).toContain("timestamp,eqp_id,event");
    for (const p of ["/api/ees/overview", "/api/fdc/summary", "/api/qms/summary", "/api/ams/stats", "/api/bus"]) {
      expect((await call("GET", p)).status, p).toBe(200);
    }
    const runs = (await call("GET", "/api/fdc/runs?limit=5")).data;
    expect(runs.length).toBeGreaterThan(0);
    const trace = await call("GET", `/api/fdc/runs/${runs[0].runId}/csv`);
    expect(String(trace.data)).toContain("run_id");
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });
});
