import type { EquipmentInfoPayload } from "../../shared/types";

export type SystemId = "EES" | "FDC" | "QMS" | "AMS";

export interface FabSystem {
  readonly id: SystemId;
  /** Called a few times per second with the simulated clock for time-driven rules. */
  tick(now: number): void;
  /** Drop runtime data (history, learned models), keep configuration. */
  reset(): void;
}

export function mean(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n - 1). */
export function std(xs: readonly number[], m = mean(xs)): number {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Std of the residuals around a least-squares line: noise without the trend. */
export function residualStd(ts: readonly number[], xs: readonly number[]): number {
  const n = xs.length;
  if (n < 3) return std(xs);
  const mt = mean(ts);
  const mx = mean(xs);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (ts[i] - mt) * (xs[i] - mx);
    sxx += (ts[i] - mt) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += (xs[i] - mx - b * (ts[i] - mt)) ** 2;
  return Math.sqrt(s / (n - 2));
}

export function pushRing<T>(arr: T[], item: T, max: number) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

export function round(v: number, digits = 4): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Master data the systems keep from `eqp/+/info` (no direct access to the simulator). */
export class MasterData {
  private map = new Map<string, EquipmentInfoPayload>();

  apply(info: EquipmentInfoPayload) {
    if (info.removed) this.map.delete(info.eqpId);
    else this.map.set(info.eqpId, info);
  }

  get(eqpId: string) {
    return this.map.get(eqpId);
  }

  all() {
    return [...this.map.values()];
  }

  tolerance(eqpId: string, param: string): number {
    return this.map.get(eqpId)?.parameters.find((p) => p.key === param)?.tolerance ?? 0;
  }
}

export function matchesFilter(value: string, filter: string | undefined): boolean {
  return !filter || filter === "*" || value === filter;
}
