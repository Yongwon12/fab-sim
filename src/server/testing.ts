import { MessageBus } from "./bus/message-bus";
import { Simulator } from "./simulator/simulator";
import { createEquipmentFromTemplate } from "./simulator/templates";
import { FdcSystem } from "./systems/fdc";
import { EesSystem } from "./systems/ees";
import { QmsSystem } from "./systems/qms";
import { AmsSystem } from "./systems/ams";
import type { EquipmentConfig, Envelope } from "../shared/types";

/** A headless fab for tests: bus, systems and simulator on a fixed clock and seed. */
export function createRig(configs: EquipmentConfig[], seed = 7) {
  const bus = new MessageBus();
  const fdc = new FdcSystem(bus);
  const ees = new EesSystem(bus);
  const qms = new QmsSystem(bus);
  const ams = new AmsSystem(bus);
  const sim = new Simulator(bus, { seed, startTime: Date.UTC(2026, 9, 14) });
  sim.load(configs);
  const seen: Envelope[] = [];
  bus.tap((m) => {
    if (m.kind !== "trace") seen.push(m);
  });
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 1000) {
      sim.runFor(Math.min(1000, ms - t));
      for (const s of [fdc, ees, qms, ams]) s.tick(sim.now());
    }
  };
  return { bus, sim, fdc, ees, qms, ams, seen, run };
}

export function quietEtch(id = "ETCH-T1", vendor: EquipmentConfig["vendor"] = "VA"): EquipmentConfig {
  const cfg = createEquipmentFromTemplate({ id, type: "ETCH", vendor });
  cfg.generation.alarmRatePerHour = 0;
  return cfg;
}
