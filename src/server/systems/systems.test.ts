import { describe, expect, it } from "vitest";
import type { AlarmPayload, CommandPayload, FdcAlarmPayload, MetrologyPayload, SystemAlarmPayload } from "../../shared/types";
import { topics } from "../../shared/topics";
import { MessageBus } from "../bus/message-bus";
import { createRig, quietEtch } from "../testing";
import { AmsSystem } from "./ams";
import { QmsSystem } from "./qms";
import { defaultFab } from "../simulator/templates";

describe("FDC", () => {
  it("learns limits, then detects and classifies an injected shift and interlocks the tool", () => {
    const cfg = quietEtch();
    cfg.generation.autoRecoverSec = 0;
    const rig = createRig([cfg]);
    const holds: CommandPayload[] = [];
    rig.bus.subscribe("T", "eqp/+/cmd", (m) => holds.push(m.payload as CommandPayload));
    rig.run(20 * 60_000);
    expect(rig.fdc.summary().models.active).toBeGreaterThan(0);
    const before = rig.fdc.listFaults({}).length;
    rig.sim.addFault({ eqpId: cfg.id, chamberId: "PM1", param: "rf_source_power", type: "SHIFT", magnitude: 60, probability: 0, processOnly: true, enabled: true, durationSec: 0 });
    rig.run(5 * 60_000);
    const faults = rig.fdc.listFaults({}).slice(0, rig.fdc.listFaults({}).length - before);
    const shift = faults.find((f) => f.param === "rf_source_power" && f.chamberId === "PM1");
    expect(shift).toMatchObject({ faultClass: "SHIFT", severity: "CRITICAL", interlock: true });
    expect(holds.some((h) => h.action === "HOLD" && h.requestedBy === "FDC")).toBe(true);
    expect(rig.sim.statusOf(cfg.id)!.holdReason).toContain("FDC interlock");
    // AMS got it, deduplicated per chamber/parameter/class
    const ams = rig.ams.listAlarms({ source: "FDC", openOnly: true }).filter((a) => a.code === "FDC-SHIFT-RF_SOURCE_POWER");
    expect(ams).toHaveLength(1);
  });

  it("classifies a noise fault", () => {
    const cfg = quietEtch();
    const rig = createRig([cfg]);
    rig.run(20 * 60_000);
    rig.sim.addFault({ eqpId: cfg.id, chamberId: "PM2", param: "gas_ar", type: "NOISE", magnitude: 6, probability: 0, processOnly: true, enabled: true, durationSec: 0 });
    rig.run(4 * 60_000);
    expect(rig.fdc.listFaults({}).some((f) => f.chamberId === "PM2" && f.param === "gas_ar" && f.faultClass === "NOISE")).toBe(true);
  });

  it("stays quiet on a healthy fab (false alarm rate under 3% of runs)", () => {
    const rig = createRig(defaultFab().map((c) => ({ ...c, generation: { ...c.generation, alarmRatePerHour: 0 } })), 11);
    rig.run(90 * 60_000);
    const { runs, faults, interlocks } = rig.fdc.summary().counters;
    expect(runs).toBeGreaterThan(300);
    expect(faults / runs).toBeLessThan(0.03);
    expect(interlocks).toBe(0);
  });

  it("keeps working when event reports are switched off (context rides on the trace)", () => {
    const cfg = quietEtch();
    for (const k of Object.keys(cfg.generation.eventsEnabled)) cfg.generation.eventsEnabled[k as keyof typeof cfg.generation.eventsEnabled] = false;
    const rig = createRig([cfg]);
    rig.run(15 * 60_000);
    expect(rig.fdc.listRuns({}).filter((r) => r.status !== "RUNNING").length).toBeGreaterThan(5);
  });
});

describe("QMS", () => {
  const point = (eqpId: string, lotId: string, value: number, i: number): MetrologyPayload => ({
    eqpId,
    eqpType: "ETCH",
    chamberId: "PM1",
    runId: `R${i}`,
    lotId,
    waferId: `${lotId}.${i}`,
    recipeId: "X",
    items: [{ key: "depth", name: "Depth", unit: "nm", value, target: 100, usl: 110, lsl: 90 }],
  });

  it("learns limits, flags OOC/OOS, holds the lot and allows disposition", () => {
    const bus = new MessageBus();
    const qms = new QmsSystem(bus);
    const alarms: SystemAlarmPayload[] = [];
    bus.subscribe("T", topics.qmsAlarm, (m) => alarms.push(m.payload as SystemAlarmPayload));
    const noise = [0.3, -0.5, 0.8, -0.2, 0.1, -0.7, 0.4, -0.3, 0.6, -0.1];
    for (let i = 0; i < 20; i++) bus.publish(topics.metrology("E1"), "metrology", "t", point("E1", "L1", 100 + noise[i % 10], i), i);
    const chart = qms.getChart("E1|depth")!;
    expect(chart.limitSource).toBe("AUTO");
    expect(chart.ucl!).toBeGreaterThan(100);
    bus.publish(topics.metrology("E1"), "metrology", "t", point("E1", "L2", 104, 21), 21);
    expect(alarms.at(-1)!.code).toBe("QMS-OOC-DEPTH");
    bus.publish(topics.metrology("E1"), "metrology", "t", point("E1", "L2", 112, 22), 22);
    expect(alarms.at(-1)!.code).toBe("QMS-OOS-DEPTH");
    expect(qms.listLots({ status: "HOLD" }).map((l) => l.lotId)).toEqual(["L2"]);
    expect(qms.disposition("L2", "RELEASED", "qe", 30).status).toBe("RELEASED");
    expect(() => qms.disposition("L1", "SCRAPPED", "qe", 31)).toThrow();
    expect(qms.listCharts({})[0].cpk).not.toBeNull();
  });
});

describe("AMS", () => {
  const eqAlarm = (set: boolean): AlarmPayload => ({ eqpId: "E1", chamberId: "PM1", alid: 1, code: "A-1", text: "x", severity: "MAJOR", category: "HARDWARE", set });

  it("deduplicates, follows the lifecycle and escalates unacknowledged alarms", () => {
    const bus = new MessageBus();
    const ams = new AmsSystem(bus);
    bus.publish(topics.alarm("E1"), "alarm", "E1", eqAlarm(true), 0);
    bus.publish(topics.alarm("E1"), "alarm", "E1", eqAlarm(true), 1000);
    let list = ams.listAlarms({});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ state: "ACTIVE", count: 2 });
    expect(ams.listNotifications().some((n) => n.group === "EQP-ENG" && n.reason === "NEW")).toBe(true);
    ams.tick(200_000);
    expect(ams.listNotifications().some((n) => n.reason === "ESCALATION" && n.group === "SHIFT-LEAD")).toBe(true);
    bus.publish(topics.alarm("E1"), "alarm", "E1", eqAlarm(false), 210_000);
    expect(ams.listAlarms({})[0].state).toBe("CLEARED");
    ams.ack(list[0].id, "op", 220_000);
    list = ams.listAlarms({});
    expect(list[0].state).toBe("CLOSED");
  });

  it("closes latching FDC alarms on acknowledge and detects floods", () => {
    const bus = new MessageBus();
    const ams = new AmsSystem(bus);
    const f: FdcAlarmPayload = {
      eqpId: "E2", chamberId: "PM1", runId: "R", lotId: "L", waferIds: [], recipeId: "X", stepNo: 1, stepName: "s", param: "p", indicator: "mean",
      value: 1, lcl: 0, ucl: 0.5, faultClass: "SHIFT", severity: "CRITICAL", interlock: false, message: "m",
    };
    bus.publish(topics.fdcAlarm, "fdc.alarm", "FDC", f, 0);
    const a = ams.listAlarms({ source: "FDC" })[0];
    expect(ams.ack(a.id, "op", 10).state).toBe("CLOSED");
    for (let i = 0; i < 15; i++) {
      bus.publish(topics.alarm("E3"), "alarm", "E3", { ...eqAlarm(true), eqpId: "E3", code: `C-${i}` }, i * 1000);
    }
    expect(ams.listAlarms({ source: "AMS" })[0]?.code).toBe("AMS-ALARM-FLOOD");
  });
});

describe("EES", () => {
  it("accounts E10 time and derives KPIs", () => {
    const cfg = quietEtch();
    const rig = createRig([cfg]);
    rig.run(30 * 60_000);
    const k = rig.ees.kpis(cfg.id, rig.sim.now())!;
    expect(k.totalSec).toBeGreaterThan(1700);
    expect(k.durations.PRD).toBeGreaterThan(0);
    expect(k.utilization).toBeGreaterThan(0.5);
    expect(k.performance).toBeGreaterThan(0.8);
    expect(k.wafers).toBeGreaterThan(10);
    expect(rig.ees.listLots({}).length).toBeGreaterThan(0);
    expect(rig.ees.listEvents({ name: "PROCESS_END" }).length).toBe(k.runs);
  });

  it("alerts AMS about a long unscheduled down and a lost link", () => {
    const cfg = quietEtch();
    cfg.generation.autoRecoverSec = 0;
    const rig = createRig([cfg]);
    rig.run(10_000);
    rig.sim.command(cfg.id, { action: "RAISE_ALARM", args: { code: "TRN-ROBOT-HANDOFF" }, origin: "LOCAL", requestedBy: "t" });
    rig.run(150_000);
    expect(rig.ams.listAlarms({ source: "EES" }).map((a) => a.code)).toContain("EES-LONG-UDT");
    rig.sim.command(cfg.id, { action: "OFFLINE", origin: "LOCAL", requestedBy: "t" });
    expect(rig.ams.listAlarms({ source: "EES" }).map((a) => a.code)).toContain("EES-LINK-OFFLINE");
  });
});
