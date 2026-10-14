import type {
  AlarmDef,
  EquipmentConfig,
  EquipmentType,
  EventName,
  GenerationConfig,
  MetrologyItemDef,
  ParameterDef,
  Recipe,
  VendorId,
} from "../../shared/types";
import { EVENT_NAMES } from "../../shared/types";

// Built-in equipment type templates. Values are plausible for a test
// simulator, compressed in time (a recipe runs in one to three minutes) so
// that data accumulates quickly; the simulation speed control compresses it
// further.

interface TypeTemplate {
  type: EquipmentType;
  label: string;
  area: string;
  processMode: "single" | "batch";
  defaultChambers: string[];
  parameters: ParameterDef[];
  recipes: Recipe[];
  alarms: AlarmDef[];
  metrology: MetrologyItemDef[];
  generation: Partial<GenerationConfig>;
}

const p = (
  key: string,
  name: string,
  unit: ParameterDef["unit"],
  idle: number,
  noise: number,
  tau: number,
  min: number,
  max: number,
  tolerance: number,
  aging?: number,
): ParameterDef => ({ key, name, unit, idle, noise, tau, min, max, tolerance, aging });

const COMMON_ALARMS: AlarmDef[] = [
  {
    code: "SAF-DOOR-OPEN",
    alid: 1001,
    text: "Chamber door interlock open",
    severity: "CRITICAL",
    category: "SAFETY",
    stopsEquipment: true,
  },
  {
    code: "TRN-ROBOT-HANDOFF",
    alid: 1101,
    text: "Transfer robot handoff error",
    severity: "MAJOR",
    category: "TRANSFER",
    stopsEquipment: true,
  },
  {
    code: "TRN-WAFER-SLIDE",
    alid: 1102,
    text: "Wafer slide detected on chuck",
    severity: "MAJOR",
    category: "TRANSFER",
    stopsEquipment: true,
  },
  {
    code: "UTL-VAC-PUMP",
    alid: 1201,
    text: "Vacuum pump current high",
    severity: "WARNING",
    category: "UTILITY",
    stopsEquipment: false,
    autoClearSec: 40,
  },
  {
    code: "UTL-CDA-LOW",
    alid: 1202,
    text: "CDA supply pressure low",
    severity: "WARNING",
    category: "UTILITY",
    stopsEquipment: false,
    autoClearSec: 25,
  },
  {
    code: "UTL-PCW-FLOW",
    alid: 1203,
    text: "Process cooling water flow low",
    severity: "WARNING",
    category: "UTILITY",
    stopsEquipment: false,
    autoClearSec: 30,
  },
];

const interlock = (code: string, alid: number, text: string, param: string): AlarmDef => ({
  code,
  alid,
  text,
  severity: "MAJOR",
  category: "PROCESS",
  stopsEquipment: false,
  param,
});

const TEMPLATES: Record<EquipmentType, TypeTemplate> = {
  ETCH: {
    type: "ETCH",
    label: "Dry Etch (ICP)",
    area: "ETCH",
    processMode: "single",
    defaultChambers: ["PM1", "PM2"],
    parameters: [
      p("rf_source_power", "RF Source Power", "W", 0, 3, 0.4, 0, 3000, 30),
      p("rf_bias_power", "RF Bias Power", "W", 0, 2, 0.4, 0, 2000, 20),
      p("rf_reflected", "RF Reflected Power", "W", 0, 0.4, 0.3, 0, 200, 4, 10),
      p("chamber_pressure", "Chamber Pressure", "mTorr", 0.5, 0.25, 1.5, 0, 500, 2, 0.5),
      p("gas_cf4", "CF4 Flow", "sccm", 0, 0.5, 0.8, 0, 500, 3),
      p("gas_o2", "O2 Flow", "sccm", 0, 0.25, 0.8, 0, 200, 2),
      p("gas_ar", "Ar Flow", "sccm", 0, 1, 0.8, 0, 1000, 5),
      p("esc_temp", "ESC Temperature", "°C", 40, 0.08, 15, -20, 120, 1),
      p("he_pressure", "He Backside Pressure", "Torr", 0, 0.04, 0.8, 0, 30, 0.5),
      p("throttle_valve", "Throttle Valve", "%", 100, 0.3, 0.8, 0, 100, 5, 1),
    ],
    recipes: [
      {
        id: "ETCH_OX_MAIN",
        name: "Oxide Contact Etch",
        steps: [
          {
            name: "Stabilize",
            duration: 10,
            setpoints: { chamber_pressure: 30, gas_ar: 200, gas_cf4: 50, he_pressure: 10, throttle_valve: 45 },
          },
          {
            name: "Breakthrough",
            duration: 8,
            setpoints: {
              rf_source_power: 800,
              rf_bias_power: 200,
              rf_reflected: 4,
              chamber_pressure: 10,
              gas_cf4: 80,
              gas_ar: 100,
              he_pressure: 10,
              throttle_valve: 30,
            },
          },
          {
            name: "Main Etch",
            duration: 40,
            setpoints: {
              rf_source_power: 1500,
              rf_bias_power: 600,
              rf_reflected: 6,
              chamber_pressure: 30,
              gas_cf4: 120,
              gas_o2: 20,
              gas_ar: 300,
              he_pressure: 10,
              throttle_valve: 42,
            },
          },
          {
            name: "Over Etch",
            duration: 15,
            setpoints: {
              rf_source_power: 1200,
              rf_bias_power: 300,
              rf_reflected: 5,
              chamber_pressure: 40,
              gas_cf4: 60,
              gas_o2: 10,
              gas_ar: 300,
              he_pressure: 10,
              throttle_valve: 48,
            },
          },
          { name: "Purge", duration: 8, setpoints: { chamber_pressure: 5, gas_ar: 500, throttle_valve: 100 } },
        ],
      },
      {
        id: "ETCH_POLY_STD",
        name: "Poly Gate Etch",
        steps: [
          {
            name: "Stabilize",
            duration: 8,
            setpoints: { chamber_pressure: 15, gas_ar: 150, he_pressure: 8, throttle_valve: 40 },
          },
          {
            name: "Main Etch",
            duration: 35,
            setpoints: {
              rf_source_power: 900,
              rf_bias_power: 150,
              rf_reflected: 3,
              chamber_pressure: 15,
              gas_cf4: 40,
              gas_o2: 8,
              gas_ar: 150,
              he_pressure: 8,
              throttle_valve: 38,
            },
          },
          { name: "Purge", duration: 6, setpoints: { chamber_pressure: 5, gas_ar: 400, throttle_valve: 100 } },
        ],
      },
    ],
    alarms: [
      ...COMMON_ALARMS,
      interlock("PRC-RF-REFL-HIGH", 2001, "RF reflected power high", "rf_reflected"),
      interlock("PRC-PRESSURE-DEV", 2002, "Chamber pressure deviation", "chamber_pressure"),
      interlock("PRC-HE-LEAK", 2003, "He backside pressure deviation (leak)", "he_pressure"),
      interlock("PRC-MFC-CF4-DEV", 2004, "CF4 MFC flow deviation", "gas_cf4"),
    ],
    metrology: [
      {
        key: "etch_depth",
        name: "Etch Depth",
        unit: "nm",
        target: 1200,
        usl: 1260,
        lsl: 1140,
        noise: 6,
        sensitivity: { rf_source_power: 0.6, rf_bias_power: 0.3, chamber_pressure: -0.2, gas_cf4: 0.25 },
        aging: -0.2,
      },
      {
        key: "cd",
        name: "Bottom CD",
        unit: "nm",
        target: 45,
        usl: 48,
        lsl: 42,
        noise: 0.35,
        sensitivity: { rf_bias_power: -0.25, gas_o2: 0.15, esc_temp: 0.5 },
      },
      {
        key: "uniformity",
        name: "Depth Uniformity",
        unit: "%",
        target: 2,
        usl: 4,
        noise: 0.15,
        sensitivity: { he_pressure: 8, chamber_pressure: 4 },
        absolute: true,
      },
    ],
    generation: { defaultRecipeId: "ETCH_OX_MAIN" },
  },
  CVD: {
    type: "CVD",
    label: "PECVD",
    area: "THIN FILM",
    processMode: "single",
    defaultChambers: ["PM1", "PM2"],
    parameters: [
      p("rf_power", "RF Power", "W", 0, 2, 0.4, 0, 2000, 15),
      p("rf_reflected", "RF Reflected Power", "W", 0, 0.3, 0.3, 0, 100, 3, 10),
      p("chamber_pressure", "Chamber Pressure", "Torr", 0.01, 0.004, 1.5, 0, 20, 0.05),
      p("heater_temp", "Heater Temperature", "°C", 400, 0.2, 20, 0, 650, 2),
      p("gas_sih4", "SiH4 Flow", "sccm", 0, 0.3, 0.8, 0, 500, 2),
      p("gas_n2o", "N2O Flow", "sccm", 0, 5, 0.8, 0, 10000, 30),
      p("gas_he", "He Carrier Flow", "sccm", 0, 4, 0.8, 0, 5000, 20),
      p("throttle_valve", "Throttle Valve", "%", 100, 0.3, 0.8, 0, 100, 5, 1),
    ],
    recipes: [
      {
        id: "CVD_SIO2_5K",
        name: "PE-Oxide 5000A",
        steps: [
          { name: "Pump", duration: 5, setpoints: { chamber_pressure: 0.01 } },
          {
            name: "Stabilize",
            duration: 12,
            setpoints: { chamber_pressure: 3.5, gas_n2o: 3000, gas_he: 1000, throttle_valve: 40 },
          },
          {
            name: "Deposition",
            duration: 45,
            setpoints: {
              rf_power: 600,
              rf_reflected: 3,
              chamber_pressure: 3.5,
              gas_sih4: 150,
              gas_n2o: 3000,
              gas_he: 1000,
              throttle_valve: 38,
            },
          },
          { name: "Purge", duration: 10, setpoints: { chamber_pressure: 2, gas_n2o: 2000, throttle_valve: 60 } },
          { name: "Pump", duration: 5, setpoints: { chamber_pressure: 0.01 } },
        ],
      },
      {
        id: "CVD_SIN_2K",
        name: "PE-Nitride 2000A",
        steps: [
          { name: "Stabilize", duration: 10, setpoints: { chamber_pressure: 4, gas_he: 2000, throttle_valve: 42 } },
          {
            name: "Deposition",
            duration: 30,
            setpoints: {
              rf_power: 450,
              rf_reflected: 2.5,
              chamber_pressure: 4,
              gas_sih4: 90,
              gas_he: 2000,
              throttle_valve: 40,
            },
          },
          { name: "Pump", duration: 6, setpoints: { chamber_pressure: 0.01 } },
        ],
      },
    ],
    alarms: [
      ...COMMON_ALARMS,
      interlock("PRC-RF-REFL-HIGH", 2001, "RF reflected power high", "rf_reflected"),
      interlock("PRC-PRESSURE-DEV", 2002, "Chamber pressure deviation", "chamber_pressure"),
      interlock("PRC-HEATER-DEV", 2005, "Heater temperature deviation", "heater_temp"),
      interlock("PRC-MFC-SIH4-DEV", 2006, "SiH4 MFC flow deviation", "gas_sih4"),
    ],
    metrology: [
      {
        key: "thickness",
        name: "Film Thickness",
        unit: "Å",
        target: 5000,
        usl: 5150,
        lsl: 4850,
        noise: 14,
        sensitivity: { rf_power: 0.5, gas_sih4: 0.6, chamber_pressure: -0.2, heater_temp: 0.3 },
        aging: -0.1,
      },
      {
        key: "uniformity",
        name: "Thickness Uniformity",
        unit: "%",
        target: 1.5,
        usl: 3,
        noise: 0.1,
        sensitivity: { chamber_pressure: 3, heater_temp: 20 },
        absolute: true,
      },
      {
        key: "refractive_index",
        name: "Refractive Index",
        unit: "",
        target: 1.46,
        usl: 1.47,
        lsl: 1.45,
        noise: 0.0015,
        sensitivity: { gas_n2o: -0.02, gas_sih4: 0.03 },
      },
    ],
    generation: { defaultRecipeId: "CVD_SIO2_5K" },
  },
  PVD: {
    type: "PVD",
    label: "PVD (DC Magnetron)",
    area: "METAL",
    processMode: "single",
    defaultChambers: ["PM1", "PM2"],
    parameters: [
      p("dc_power", "DC Power", "kW", 0, 0.04, 0.4, 0, 40, 0.3),
      p("target_voltage", "Target Voltage", "V", 0, 1.5, 0.4, 0, 1000, 10, 0.3),
      p("rf_bias_power", "RF Bias Power", "W", 0, 1, 0.4, 0, 1000, 10),
      p("gas_ar", "Ar Flow", "sccm", 0, 0.3, 0.8, 0, 200, 2),
      p("chamber_pressure", "Chamber Pressure", "mTorr", 0.01, 0.04, 1, 0, 50, 0.5),
      p("heater_temp", "Heater Temperature", "°C", 300, 0.2, 20, 0, 500, 2),
      p("magnet_speed", "Magnet Rotation", "rpm", 60, 0.4, 2, 0, 120, 2),
    ],
    recipes: [
      {
        id: "PVD_TI_300A",
        name: "Ti Liner 300A",
        steps: [
          { name: "Gas Stabilize", duration: 8, setpoints: { gas_ar: 40, chamber_pressure: 3 } },
          {
            name: "Ignition",
            duration: 3,
            setpoints: { dc_power: 2, target_voltage: 350, gas_ar: 40, chamber_pressure: 3 },
          },
          {
            name: "Deposition",
            duration: 30,
            setpoints: { dc_power: 12, target_voltage: 480, rf_bias_power: 100, gas_ar: 40, chamber_pressure: 3 },
          },
          { name: "Cool Down", duration: 6, setpoints: { gas_ar: 20, chamber_pressure: 1 } },
        ],
      },
    ],
    alarms: [
      ...COMMON_ALARMS,
      interlock("PRC-ARC-DETECT", 2007, "Target arc detected (voltage deviation)", "target_voltage"),
      interlock("PRC-PRESSURE-DEV", 2002, "Chamber pressure deviation", "chamber_pressure"),
      interlock("PRC-HEATER-DEV", 2005, "Heater temperature deviation", "heater_temp"),
    ],
    metrology: [
      {
        key: "thickness",
        name: "Film Thickness",
        unit: "Å",
        target: 300,
        usl: 315,
        lsl: 285,
        noise: 1.4,
        sensitivity: { dc_power: 0.9, gas_ar: -0.1, chamber_pressure: -0.15 },
        aging: -0.2,
      },
      {
        key: "sheet_resistance",
        name: "Sheet Resistance",
        unit: "Ω/sq",
        target: 25,
        usl: 27,
        lsl: 23,
        noise: 0.12,
        sensitivity: { dc_power: -0.85, heater_temp: -0.3 },
      },
    ],
    generation: { defaultRecipeId: "PVD_TI_300A" },
  },
  CMP: {
    type: "CMP",
    label: "CMP (Oxide)",
    area: "CMP",
    processMode: "single",
    defaultChambers: ["P1", "P2"],
    parameters: [
      p("platen_speed", "Platen Speed", "rpm", 0, 0.3, 1, 0, 150, 2),
      p("head_speed", "Head Speed", "rpm", 0, 0.3, 1, 0, 150, 2),
      p("down_force", "Down Force", "psi", 0, 0.02, 0.5, 0, 10, 0.2),
      p("slurry_flow", "Slurry Flow", "ml/min", 0, 1, 1, 0, 500, 5),
      p("pad_temp", "Pad Temperature", "°C", 25, 0.1, 10, 0, 80, 2),
      p("motor_current", "Platen Motor Current", "A", 2, 0.05, 0.5, 0, 30, 0.5, 0.6),
    ],
    recipes: [
      {
        id: "CMP_OX_STD",
        name: "ILD Oxide Polish",
        steps: [
          { name: "Load", duration: 5, setpoints: { platen_speed: 30, head_speed: 30 } },
          {
            name: "Main Polish",
            duration: 55,
            setpoints: {
              platen_speed: 93,
              head_speed: 87,
              down_force: 3.5,
              slurry_flow: 200,
              pad_temp: 42,
              motor_current: 12,
            },
          },
          {
            name: "Over Polish",
            duration: 15,
            setpoints: {
              platen_speed: 63,
              head_speed: 57,
              down_force: 2,
              slurry_flow: 150,
              pad_temp: 38,
              motor_current: 8,
            },
          },
          {
            name: "Rinse",
            duration: 10,
            setpoints: { platen_speed: 30, head_speed: 30, down_force: 0.5, pad_temp: 30, motor_current: 4 },
          },
          { name: "Unload", duration: 5, setpoints: {} },
        ],
      },
    ],
    alarms: [
      ...COMMON_ALARMS,
      interlock("PRC-SLURRY-FLOW", 2008, "Slurry flow deviation", "slurry_flow"),
      interlock("PRC-DOWNFORCE-DEV", 2009, "Head down force deviation", "down_force"),
      interlock("PRC-MOTOR-OVERLOAD", 2010, "Platen motor current deviation", "motor_current"),
    ],
    metrology: [
      {
        key: "removal",
        name: "Removal Amount",
        unit: "Å",
        target: 5000,
        usl: 5250,
        lsl: 4750,
        noise: 18,
        sensitivity: { down_force: 0.9, platen_speed: 0.7, slurry_flow: 0.15 },
        aging: -0.15,
      },
      {
        key: "remaining",
        name: "Remaining Thickness",
        unit: "Å",
        target: 3000,
        usl: 3200,
        lsl: 2800,
        noise: 14,
        sensitivity: { down_force: -1.4, platen_speed: -1.1 },
        aging: 0.2,
      },
      {
        key: "uniformity",
        name: "WIWNU",
        unit: "%",
        target: 3,
        usl: 5,
        noise: 0.2,
        sensitivity: { head_speed: 6, down_force: 3 },
        absolute: true,
      },
    ],
    generation: { defaultRecipeId: "CMP_OX_STD" },
  },
  DIFF: {
    type: "DIFF",
    label: "Diffusion Furnace (batch)",
    area: "DIFFUSION",
    processMode: "batch",
    defaultChambers: ["TUBE1"],
    parameters: [
      p("zone1_temp", "Zone 1 Temperature", "°C", 650, 0.15, 8, 0, 1250, 1.5),
      p("zone2_temp", "Zone 2 Temperature", "°C", 650, 0.15, 8, 0, 1250, 1.5),
      p("zone3_temp", "Zone 3 Temperature", "°C", 650, 0.15, 8, 0, 1250, 1.5),
      p("gas_n2", "N2 Flow", "sccm", 5000, 15, 2, 0, 20000, 100),
      p("gas_o2", "O2 Flow", "sccm", 0, 10, 2, 0, 10000, 80),
      p("tube_pressure", "Tube Pressure", "Torr", 760, 0.4, 2, 0, 800, 3),
    ],
    recipes: [
      {
        id: "DIFF_OX_DRY",
        name: "Dry Oxidation 1000A",
        steps: [
          { name: "Boat In / Purge", duration: 20, setpoints: { gas_n2: 10000 } },
          {
            name: "Ramp Up",
            duration: 35,
            setpoints: { zone1_temp: 900, zone2_temp: 900, zone3_temp: 900, gas_n2: 10000 },
          },
          {
            name: "Oxidation",
            duration: 80,
            setpoints: { zone1_temp: 900, zone2_temp: 900, zone3_temp: 900, gas_n2: 0, gas_o2: 8000 },
          },
          {
            name: "Anneal",
            duration: 30,
            setpoints: { zone1_temp: 900, zone2_temp: 900, zone3_temp: 900, gas_n2: 10000 },
          },
          { name: "Ramp Down / Boat Out", duration: 30, setpoints: { gas_n2: 10000 } },
        ],
      },
    ],
    alarms: [
      ...COMMON_ALARMS,
      interlock("PRC-TEMP-DEV", 2011, "Furnace zone temperature deviation", "zone2_temp"),
      interlock("PRC-GAS-O2-DEV", 2012, "O2 flow deviation", "gas_o2"),
      interlock("PRC-PRESSURE-DEV", 2002, "Tube pressure deviation", "tube_pressure"),
    ],
    metrology: [
      {
        key: "oxide_thickness",
        name: "Oxide Thickness",
        unit: "Å",
        target: 1000,
        usl: 1030,
        lsl: 970,
        noise: 3,
        sensitivity: { zone2_temp: 2.5, zone1_temp: 0.5, zone3_temp: 0.5, gas_o2: 0.3 },
        aging: 0.01,
      },
      {
        key: "uniformity",
        name: "Within-Batch Uniformity",
        unit: "%",
        target: 1,
        usl: 2,
        noise: 0.08,
        sensitivity: { zone1_temp: 25, zone3_temp: 25 },
        absolute: true,
      },
    ],
    generation: { defaultRecipeId: "DIFF_OX_DRY", wafersPerLot: 25, metrologyRate: 0.12, pmIntervalWafers: 0 },
  },
};

export const EQUIPMENT_TYPES = Object.keys(TEMPLATES) as EquipmentType[];

export function templateInfo() {
  return EQUIPMENT_TYPES.map((type) => {
    const t = TEMPLATES[type];
    return {
      type,
      label: t.label,
      area: t.area,
      processMode: t.processMode,
      defaultChambers: t.defaultChambers,
      recipes: t.recipes.map((r) => r.id),
    };
  });
}

function defaultGeneration(overrides: Partial<GenerationConfig>): GenerationConfig {
  const eventsEnabled = Object.fromEntries(EVENT_NAMES.map((e) => [e, true])) as Record<EventName, boolean>;
  return {
    traceEnabled: true,
    traceIntervalMs: 1000,
    traceIdle: false,
    traceParams: [],
    noiseScale: 1,
    driftPerWafer: 0.0002,
    eventsEnabled,
    eventReportVars: {},
    alarmRatePerHour: 1.5,
    autoRecoverSec: 60,
    autoRun: true,
    lotIntervalSec: 0,
    wafersPerLot: 6,
    defaultRecipeId: "",
    metrologyRate: 0.5,
    transferSec: 6,
    pmIntervalWafers: 250,
    pmDurationSec: 180,
    ...overrides,
  };
}

const MODELS: Record<VendorId, Record<EquipmentType, string>> = {
  VA: { ETCH: "AX-Etch 3000", CVD: "AX-Dep P5", PVD: "AX-Sputter E", CMP: "AX-Polish 2", DIFF: "AX-Therm V" },
  VB: { ETCH: "LP Orion-E", CVD: "LP Vega-D", PVD: "LP Metal-7", CMP: "LP Planar-2", DIFF: "LP Furn-12" },
  VC: { ETCH: "KT Kestrel-E", CVD: "KT Nimbus-D", PVD: "KT Ex-Met", CMP: "KT Flat-3", DIFF: "KT Thermo-V" },
};

export interface NewEquipmentInput {
  id: string;
  type: EquipmentType;
  vendor: VendorId;
  name?: string;
  chambers?: string[];
  loadPorts?: number;
}

/** Lot arrival interval that keeps the tool about 85% busy. */
export function suggestedLotInterval(cfg: Pick<EquipmentConfig, "recipes" | "chambers" | "processMode" | "generation">): number {
  const g = cfg.generation;
  const recipe = cfg.recipes.find((r) => r.id === g.defaultRecipeId) ?? cfg.recipes[0];
  const cycle = (recipe?.steps.reduce((s, x) => s + x.duration, 0) ?? 60) + g.transferSec;
  const runsPerLot = cfg.processMode === "batch" ? 1 : g.wafersPerLot / cfg.chambers.length;
  return Math.max(30, Math.round((runsPerLot * cycle) / 0.85));
}

export function createEquipmentFromTemplate(input: NewEquipmentInput): EquipmentConfig {
  const t = TEMPLATES[input.type];
  const clone = <T>(v: T): T => structuredClone(v);
  const cfg: EquipmentConfig = {
    id: input.id,
    name: input.name || `${t.label} ${input.id}`,
    type: input.type,
    vendor: input.vendor,
    model: MODELS[input.vendor][input.type],
    area: t.area,
    chambers: input.chambers?.length ? input.chambers : [...t.defaultChambers],
    loadPorts: input.loadPorts ?? (t.processMode === "batch" ? 2 : 3),
    processMode: t.processMode,
    parameters: clone(t.parameters),
    recipes: clone(t.recipes),
    alarms: clone(t.alarms),
    metrology: clone(t.metrology),
    generation: defaultGeneration(clone(t.generation)),
  };
  if (!cfg.generation.lotIntervalSec) cfg.generation.lotIntervalSec = suggestedLotInterval(cfg);
  return cfg;
}

/** The default fab: a mixed line from three vendors, which is the whole point. */
export function defaultFab(): EquipmentConfig[] {
  return [
    createEquipmentFromTemplate({ id: "ETCH-01", type: "ETCH", vendor: "VA", name: "Oxide Etch #1" }),
    createEquipmentFromTemplate({ id: "ETCH-02", type: "ETCH", vendor: "VB", name: "Oxide Etch #2" }),
    createEquipmentFromTemplate({ id: "CVD-01", type: "CVD", vendor: "VC", name: "PECVD #1" }),
    createEquipmentFromTemplate({ id: "PVD-01", type: "PVD", vendor: "VB", name: "Ti/TiN PVD #1" }),
    createEquipmentFromTemplate({ id: "CMP-01", type: "CMP", vendor: "VC", name: "Oxide CMP #1" }),
    createEquipmentFromTemplate({ id: "DIFF-01", type: "DIFF", vendor: "VA", name: "Dry Ox Furnace #1" }),
  ];
}
