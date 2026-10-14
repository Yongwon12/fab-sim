import type { EquipmentConfig, FaultInjection, GenerationConfig, Recipe } from "../shared/types";
import { EVENT_NAMES } from "../shared/types";
import { createEquipmentFromTemplate, EQUIPMENT_TYPES } from "./simulator/templates";
import type { FdcConfig } from "./systems/fdc";
import type { EesConfig } from "./systems/ees";
import type { QmsConfig } from "./systems/qms";
import type { AmsConfig } from "./systems/ams";

/** Everything a user configures; runtime data (history, learned limits) is not part of it. */
export interface Scenario {
  version: 1;
  savedAt: string;
  sim: { seed: number; speed: number };
  equipment: EquipmentConfig[];
  faults: FaultInjection[];
  systems: {
    fdc: FdcConfig;
    ees: EesConfig;
    qms: QmsConfig;
    qmsSpecs: Record<string, { target: number; usl: number | null; lsl: number | null }>;
    ams: AmsConfig;
  };
  /** Bus routes the user switched off. */
  disabledRoutes: Array<{ subscriber: string; pattern: string }>;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

export function validateEquipment(cfg: EquipmentConfig): string[] {
  const errors: string[] = [];
  if (!ID_RE.test(cfg.id ?? "")) errors.push("id: 1–24 letters, digits, - or _");
  if (!EQUIPMENT_TYPES.includes(cfg.type)) errors.push(`type: one of ${EQUIPMENT_TYPES.join(", ")}`);
  if (!["VA", "VB", "VC"].includes(cfg.vendor)) errors.push("vendor: VA, VB or VC");
  if (!Array.isArray(cfg.chambers) || !cfg.chambers.length) errors.push("chambers: at least one");
  else {
    if (new Set(cfg.chambers).size !== cfg.chambers.length) errors.push("chambers: ids must be unique");
    for (const c of cfg.chambers) if (!ID_RE.test(c)) errors.push(`chamber ${c}: letters, digits, - or _`);
  }
  if (!Number.isInteger(cfg.loadPorts) || cfg.loadPorts < 1 || cfg.loadPorts > 6) errors.push("loadPorts: 1–6");
  const keys = new Set((cfg.parameters ?? []).map((p) => p.key));
  if (!keys.size) errors.push("parameters: at least one");
  for (const p of cfg.parameters ?? []) {
    if (!(p.max > p.min)) errors.push(`parameter ${p.key}: max must exceed min`);
    if (!(p.noise >= 0) || !(p.tau > 0) || !(p.tolerance > 0)) errors.push(`parameter ${p.key}: noise ≥ 0, tau > 0, tolerance > 0`);
  }
  if (!Array.isArray(cfg.recipes) || !cfg.recipes.length) errors.push("recipes: at least one");
  const recipeIds = new Set<string>();
  for (const r of cfg.recipes ?? []) errors.push(...validateRecipe(r, keys));
  for (const r of cfg.recipes ?? []) {
    if (recipeIds.has(r.id)) errors.push(`recipe ${r.id}: duplicate id`);
    recipeIds.add(r.id);
  }
  const g = cfg.generation;
  if (!g) errors.push("generation: missing");
  else {
    const range = (name: keyof GenerationConfig, lo: number, hi: number) => {
      const v = g[name] as number;
      if (typeof v !== "number" || !(v >= lo && v <= hi)) errors.push(`generation.${name}: ${lo}–${hi}`);
    };
    range("traceIntervalMs", 100, 60_000);
    range("noiseScale", 0, 20);
    range("driftPerWafer", 0, 0.01);
    range("alarmRatePerHour", 0, 600);
    range("autoRecoverSec", 0, 86_400);
    range("lotIntervalSec", 10, 86_400);
    range("wafersPerLot", 1, 25);
    range("metrologyRate", 0, 1);
    range("transferSec", 0, 600);
    range("pmIntervalWafers", 0, 100_000);
    range("pmDurationSec", 0, 86_400);
    if (g.defaultRecipeId && !recipeIds.has(g.defaultRecipeId)) errors.push("generation.defaultRecipeId: unknown recipe");
    for (const k of g.traceParams ?? []) if (!keys.has(k)) errors.push(`generation.traceParams: unknown ${k}`);
  }
  return errors;
}

export function validateRecipe(r: Recipe, keys: Set<string>): string[] {
  const errors: string[] = [];
  if (!ID_RE.test(r.id ?? "")) errors.push(`recipe ${r.id}: id 1–24 letters, digits, - or _`);
  if (!Array.isArray(r.steps) || !r.steps.length) errors.push(`recipe ${r.id}: at least one step`);
  for (const [i, st] of (r.steps ?? []).entries()) {
    if (!(st.duration > 0 && st.duration <= 36_000)) errors.push(`recipe ${r.id} step ${i + 1}: duration 0–36000 s`);
    for (const [k, v] of Object.entries(st.setpoints ?? {})) {
      if (!keys.has(k)) errors.push(`recipe ${r.id} step ${i + 1}: unknown parameter ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`recipe ${r.id} step ${i + 1}: ${k} must be a number`);
    }
  }
  return errors;
}

/** Fill fields missing from an imported or edited config from its type template. */
export function normalizeEquipment(input: Partial<EquipmentConfig> & Pick<EquipmentConfig, "id" | "type" | "vendor">): EquipmentConfig {
  const base = createEquipmentFromTemplate({ id: input.id, type: input.type, vendor: input.vendor });
  const generation: GenerationConfig = { ...base.generation, ...(input.generation ?? {}) };
  generation.eventsEnabled = {
    ...Object.fromEntries(EVENT_NAMES.map((e) => [e, true])),
    ...(input.generation?.eventsEnabled ?? {}),
  } as GenerationConfig["eventsEnabled"];
  generation.eventReportVars = { ...(input.generation?.eventReportVars ?? {}) };
  generation.traceParams = [...(input.generation?.traceParams ?? [])];
  return { ...base, ...input, generation } as EquipmentConfig;
}
