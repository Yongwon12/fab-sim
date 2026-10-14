import { describe, expect, it } from "vitest";
import type { CommandPayload, EventName, EventPayload, StatePayload } from "../../shared/types";
import { topics } from "../../shared/topics";
import { createRig, quietEtch } from "../testing";
import { createEquipmentFromTemplate } from "./templates";

const names = (seen: ReturnType<typeof createRig>["seen"], eqpId: string) =>
  seen.filter((m) => m.kind === "event" && (m.payload as EventPayload).eqpId === eqpId).map((m) => (m.payload as EventPayload).name);

describe("equipment simulation", () => {
  it("runs a lot end to end with ERD events in order and metrology", () => {
    const cfg = quietEtch();
    cfg.generation.autoRun = false;
    const { sim, seen, run } = createRig([cfg]);
    expect(sim.command(cfg.id, { action: "LOAD_CARRIER", args: { wafers: 2 }, origin: "LOCAL", requestedBy: "test" }).ok).toBe(true);
    expect(sim.command(cfg.id, { action: "START_LOT", args: {}, origin: "LOCAL", requestedBy: "test" }).ok).toBe(true);
    run(5 * 60_000);
    const ev = names(seen, cfg.id);
    const order: EventName[] = ["CARRIER_ARRIVED", "LOT_START", "PROCESS_START", "STEP_START", "STEP_END", "PROCESS_END", "LOT_END", "CARRIER_REMOVED"];
    let idx = -1;
    for (const n of order) {
      const next = ev.indexOf(n, idx + 1);
      expect(next, `${n} after index ${idx}`).toBeGreaterThan(idx);
      idx = next;
    }
    expect(ev.filter((n) => n === "PROCESS_END")).toHaveLength(2);
    expect(ev.filter((n) => n === "STEP_START")).toHaveLength(2 * cfg.recipes[0].steps.length);
    expect(sim.statusOf(cfg.id)!.wafersProcessed).toBe(2);
    const states = seen.filter((m) => m.kind === "state").map((m) => (m.payload as StatePayload).e10);
    expect(states).toContain("PRD");
    expect(states[states.length - 1]).toBe("SBY");
  });

  it("stops reporting to the host while OFFLINE but keeps the local feed", () => {
    const cfg = quietEtch();
    const { sim, bus, run } = createRig([cfg]);
    let local = 0;
    sim.onLocal(() => local++);
    run(60_000);
    sim.command(cfg.id, { action: "OFFLINE", origin: "LOCAL", requestedBy: "test" });
    const before = bus.getStats().byKind.trace ?? 0;
    const localBefore = local;
    run(120_000);
    expect(bus.getStats().byKind.trace ?? 0).toBe(before);
    expect(local).toBeGreaterThan(localBefore);
  });

  it("rejects host commands unless ONLINE_REMOTE (GEM)", () => {
    const cfg = quietEtch();
    const { sim, bus } = createRig([cfg]);
    sim.command(cfg.id, { action: "ONLINE_LOCAL", origin: "LOCAL", requestedBy: "test" });
    expect(sim.command(cfg.id, { action: "PM_START", origin: "HOST", requestedBy: "test" }).ok).toBe(false);
    const cmd: CommandPayload = { eqpId: cfg.id, action: "SET_MODE", args: { mode: "ENGINEERING" }, origin: "HOST", requestedBy: "test" };
    bus.publish(topics.command(cfg.id), "command", "test", cmd, sim.now());
    expect(sim.statusOf(cfg.id)!.mode).toBe("PRODUCTION");
    sim.command(cfg.id, { action: "ONLINE_REMOTE", origin: "LOCAL", requestedBy: "test" });
    bus.publish(topics.command(cfg.id), "command", "test", cmd, sim.now());
    expect(sim.statusOf(cfg.id)!.mode).toBe("ENGINEERING");
    expect(sim.statusOf(cfg.id)!.e10).toBe("ENG");
  });

  it("a stopping alarm puts the tool UDT and pauses runs until reset", () => {
    const cfg = quietEtch();
    cfg.generation.autoRecoverSec = 0;
    const { sim, run } = createRig([cfg]);
    run(30_000);
    expect(sim.statusOf(cfg.id)!.processState).toBe("EXECUTING");
    sim.command(cfg.id, { action: "RAISE_ALARM", args: { code: "SAF-DOOR-OPEN", chamberId: "PM1" }, origin: "LOCAL", requestedBy: "test" });
    let st = sim.statusOf(cfg.id)!;
    expect(st.e10).toBe("UDT");
    expect(st.processState).toBe("PAUSED");
    const elapsed = st.chambers[0].runElapsed;
    run(60_000);
    expect(sim.statusOf(cfg.id)!.chambers[0].runElapsed).toBe(elapsed);
    sim.command(cfg.id, { action: "ALARM_RESET", origin: "LOCAL", requestedBy: "test" });
    st = sim.statusOf(cfg.id)!;
    expect(st.e10).toBe("PRD");
    expect(st.processState).toBe("EXECUTING");
  });

  it("raises the equipment interlock alarm on a large deviation and clears it afterwards", () => {
    const cfg = quietEtch();
    const { sim, run } = createRig([cfg]);
    run(20_000);
    sim.addFault({ eqpId: cfg.id, chamberId: "*", param: "he_pressure", type: "SHIFT", magnitude: 5, probability: 0, processOnly: true, enabled: true, durationSec: 60 });
    run(30_000);
    expect(sim.statusOf(cfg.id)!.activeAlarms.map((a) => a.code)).toContain("PRC-HE-LEAK");
    run(5 * 60_000);
    expect(sim.statusOf(cfg.id)!.activeAlarms.map((a) => a.code)).not.toContain("PRC-HE-LEAK");
  });

  it("goes SDT for PM and resets chamber aging", () => {
    const cfg = quietEtch();
    const { sim, run } = createRig([cfg]);
    run(10 * 60_000);
    expect(sim.statusOf(cfg.id)!.chambers[0].wafersSincePm).toBeGreaterThan(0);
    sim.command(cfg.id, { action: "PM_START", origin: "LOCAL", requestedBy: "test" });
    run(5 * 60_000);
    expect(sim.statusOf(cfg.id)!.e10).toBe("SDT");
    sim.command(cfg.id, { action: "PM_END", origin: "LOCAL", requestedBy: "test" });
    expect(sim.statusOf(cfg.id)!.chambers.every((c) => c.wafersSincePm === 0)).toBe(true);
  });

  it("batch tools process the whole lot in one run", () => {
    const { sim, seen, run } = createRig([]);
    const cfg = createEquipmentFromTemplate({ id: "DIFF-T", type: "DIFF", vendor: "VC" });
    cfg.generation.alarmRatePerHour = 0;
    sim.addEquipment(cfg);
    run(6 * 60_000);
    const start = seen.find((m) => m.kind === "event" && (m.payload as EventPayload).name === "PROCESS_START");
    expect(String((start!.payload as EventPayload).reports[0].values.WaferID).split(",")).toHaveLength(25);
  });

  it("replays identically for the same seed", () => {
    const a = createRig([quietEtch()], 99);
    const b = createRig([quietEtch()], 99);
    a.run(10 * 60_000);
    b.run(10 * 60_000);
    const sig = (r: typeof a) => r.seen.filter((m) => m.kind === "metrology").map((m) => JSON.stringify(m.payload)).join();
    expect(sig(a)).toBe(sig(b));
    expect(sig(a).length).toBeGreaterThan(0);
  });
});
