import { describe, expect, it } from "vitest";
import type { VendorId } from "../../shared/types";
import { createEquipmentFromTemplate } from "./templates";
import { buildMappings, VendorLink } from "./vendors";

const VENDORS: VendorId[] = ["VA", "VB", "VC"];

describe("unified adapter round trip", () => {
  for (const vendor of VENDORS) {
    it(`${vendor}: native trace decodes back to canonical values and context`, () => {
      const cfg = createEquipmentFromTemplate({ id: "CVD-T", type: "CVD", vendor });
      const link = new VendorLink(cfg);
      const values = { rf_power: 600.37, chamber_pressure: 3.5012, heater_temp: 400.21, gas_sih4: 150.4 };
      const setpoints = { rf_power: 600, chamber_pressure: 3.5, heater_temp: 400, gas_sih4: 150 };
      const ctx = { runId: "R1", lotId: "LT1", waferIds: ["LT1.01"], recipeId: "CVD_SIO2_5K", stepNo: 3, stepName: "Deposition" };
      const out = link.trace({ eqpId: "CVD-T", chamberId: "PM2", sampleNo: 7, context: ctx, values, setpoints }, Date.UTC(2026, 9, 14));
      expect(out.chamberId).toBe("PM2");
      expect(out.context).toEqual(ctx);
      for (const [k, v] of Object.entries(values)) {
        expect(out.values[k]).toBeCloseTo(v, 1);
        expect(out.setpoints[k]).toBeCloseTo(setpoints[k as keyof typeof setpoints], 1);
      }
      expect(link.decodeErrors).toBe(0);
    });

    it(`${vendor}: events and alarms keep their canonical identity`, () => {
      const cfg = createEquipmentFromTemplate({ id: "ETCH-T", type: "ETCH", vendor });
      const link = new VendorLink(cfg);
      const ev = link.event(
        { eqpId: "ETCH-T", ceid: 0, name: "PROCESS_END", chamberId: "PM1", reports: [{ rptid: 1, values: { ChamberID: "PM1", LotID: "LT9", ProcessTime: 81.2 } }] },
        0,
      );
      expect(ev).toMatchObject({ eqpId: "ETCH-T", name: "PROCESS_END", chamberId: "PM1" });
      expect(ev.reports[0].values).toMatchObject({ LotID: "LT9", ProcessTime: 81.2 });
      const def = cfg.alarms.find((a) => a.code === "PRC-HE-LEAK")!;
      const al = link.alarm({ eqpId: "ETCH-T", chamberId: "PM2", alid: def.alid, code: def.code, text: def.text, severity: def.severity, category: def.category, set: true }, 0);
      expect(al).toMatchObject({ eqpId: "ETCH-T", chamberId: "PM2", code: "PRC-HE-LEAK", severity: "MAJOR", set: true });
      expect(link.frames().some((f) => f.kind === "alarm")).toBe(true);
    });
  }

  it("gives every vendor its own names and units for the same parameter", () => {
    const names = VENDORS.map((v) => {
      const m = buildMappings(createEquipmentFromTemplate({ id: "E1", type: "ETCH", vendor: v })).find((x) => x.key === "chamber_pressure" && x.chamberId === "PM1")!;
      return `${m.nativeName}|${m.nativeUnit}`;
    });
    expect(new Set(names).size).toBe(3);
    expect(names[1]).toContain("Pa");
    expect(names[2]).toContain("Torr");
  });
});
