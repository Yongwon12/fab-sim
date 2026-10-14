import { FabCore, type ScenarioStorage } from "../server/core";
import type { Scenario } from "../server/scenario";

// Standalone web build: the whole fab runs in this browser tab instead of on a
// Node server. The scenario is kept in browser storage when the browser allows it.

const KEY = "fab-sim.scenario";

const browserStorage: ScenarioStorage = {
  load() {
    try {
      const text = localStorage.getItem(KEY);
      return text ? (JSON.parse(text) as Scenario) : null;
    } catch {
      return null;
    }
  },
  save(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // storage blocked or full: keep running without saving
    }
  },
};

let core: FabCore | null = null;

export function localCore(): FabCore {
  if (!core) {
    core = new FabCore({ storage: browserStorage });
    core.start();
  }
  return core;
}
