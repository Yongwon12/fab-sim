import type {
  AlarmCategory,
  AlarmPayload,
  CanonicalUnit,
  CommandPayload,
  CommandResult,
  EquipmentConfig,
  EventName,
  EventPayload,
  EventReport,
  NativeFrame,
  ParamMapping,
  RunContext,
  Severity,
  TracePayload,
  VendorId,
} from "../../shared/types";
import { EVENT_NAMES } from "../../shared/types";

// Each vendor speaks its own dialect: parameter names, engineering units,
// SVID/CEID/ALID numbering, severity scales and wire format all differ. That
// is why every vendor ships its own equipment UI. The VendorLink below plays
// both sides of the wire for one tool: the vendor driver encodes canonical
// data into the vendor's native frame, and the unified adapter decodes that
// frame back into the canonical model the single UI and the fab systems use.

export interface VendorInfo {
  id: VendorId;
  name: string;
  protocol: string;
  description: string;
}

export const VENDORS: Record<VendorId, VendorInfo> = {
  VA: {
    id: "VA",
    name: "Axion Semitech",
    protocol: "SECS-II / HSMS (GEM)",
    description: "Numeric SVID/CEID/ALID, positional S6F1 trace and S6F11 reports defined by S2F23/S2F33, SI-native units.",
  },
  VB: {
    id: "VB",
    name: "Lumen Process",
    protocol: "Proprietary XML over TCP",
    description: "Named XML tags, power in kW, pressure in Pa, temperature in K, hex alarm codes with 1–4 levels.",
  },
  VC: {
    id: "VC",
    name: "Kairo Technologies",
    protocol: "OPC UA style JSON",
    description: "Node ids per variable, pressure in Torr, °F, flows in slm, force in kPa, OPC UA severity 1–1000.",
  },
};

interface UnitConv {
  unit: string;
  to: (v: number) => number;
  from: (v: number) => number;
}

const UNIT_CONVERSIONS: Record<VendorId, Partial<Record<CanonicalUnit, UnitConv>>> = {
  VA: {},
  VB: {
    W: { unit: "kW", to: (v) => v / 1000, from: (v) => v * 1000 },
    mTorr: { unit: "Pa", to: (v) => v * 0.133322, from: (v) => v / 0.133322 },
    Torr: { unit: "Pa", to: (v) => v * 133.322, from: (v) => v / 133.322 },
    "°C": { unit: "K", to: (v) => v + 273.15, from: (v) => v - 273.15 },
  },
  VC: {
    mTorr: { unit: "Torr", to: (v) => v / 1000, from: (v) => v * 1000 },
    "°C": { unit: "°F", to: (v) => (v * 9) / 5 + 32, from: (v) => ((v - 32) * 5) / 9 },
    sccm: { unit: "slm", to: (v) => v / 1000, from: (v) => v * 1000 },
    psi: { unit: "kPa", to: (v) => v * 6.894757, from: (v) => v / 6.894757 },
  },
};

function unitConv(vendor: VendorId, unit: CanonicalUnit): UnitConv {
  return UNIT_CONVERSIONS[vendor][unit] ?? { unit, to: (v) => v, from: (v) => v };
}

const words = (key: string) => key.split("_").filter(Boolean);
const pascal = (key: string) => words(key).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const camel = (key: string) => {
  const s = pascal(key);
  return s[0].toLowerCase() + s.slice(1);
};

function nativeParamName(vendor: VendorId, eqpId: string, chamberId: string, key: string): string {
  switch (vendor) {
    case "VA":
      return `${chamberId}.${pascal(key)}`;
    case "VB":
      return `${chamberId}_${key.toUpperCase()}`;
    case "VC":
      return `ns=2;s=${eqpId}/${chamberId}/${camel(key)}`;
  }
}

function svidFor(vendor: VendorId, chamberIdx: number, paramIdx: number): number {
  switch (vendor) {
    case "VA":
      return 1000 + chamberIdx * 100 + paramIdx + 1;
    case "VB":
      return 30000 + chamberIdx * 1000 + paramIdx + 1;
    case "VC":
      return 5000 + chamberIdx * 200 + paramIdx + 1;
  }
}

export function buildMappings(eq: EquipmentConfig): ParamMapping[] {
  const out: ParamMapping[] = [];
  eq.chambers.forEach((chamberId, ci) => {
    eq.parameters.forEach((param, pi) => {
      out.push({
        key: param.key,
        name: param.name,
        chamberId,
        svid: svidFor(eq.vendor, ci, pi),
        nativeName: nativeParamName(eq.vendor, eq.id, chamberId, param.key),
        canonicalUnit: param.unit,
        nativeUnit: unitConv(eq.vendor, param.unit).unit,
      });
    });
  });
  return out;
}

// ------------------------------------------------------------ vocabularies

const VB_EVENT_NAMES: Record<EventName, string> = {
  CONTROL_STATE_CHANGED: "CtrlModeChange",
  EQUIPMENT_STATE_CHANGED: "EqpStatusChange",
  CARRIER_ARRIVED: "FoupArrived",
  LOT_START: "LotBegin",
  LOT_END: "LotFinish",
  CARRIER_REMOVED: "FoupRemoved",
  PROCESS_START: "WaferBegin",
  PROCESS_END: "WaferFinish",
  STEP_START: "StepBegin",
  STEP_END: "StepFinish",
  PROCESS_PAUSED: "Hold",
  PROCESS_RESUMED: "Release",
  PROCESS_ABORTED: "Abort",
  ALARM_SET: "AlarmOn",
  ALARM_CLEARED: "AlarmOff",
  PM_START: "MaintBegin",
  PM_END: "MaintFinish",
  REMOTE_COMMAND: "HostCmd",
};

const ceidFor = (vendor: VendorId, name: EventName): number => {
  const idx = EVENT_NAMES.indexOf(name);
  return vendor === "VA" ? 4001 + idx : vendor === "VB" ? 201 + idx : 7001 + idx;
};

const eventNameByCeid = (vendor: VendorId, ceid: number): EventName | undefined =>
  EVENT_NAMES.find((n) => ceidFor(vendor, n) === ceid);

const VB_LEVEL: Record<Severity, number> = { INFO: 1, WARNING: 2, MAJOR: 3, CRITICAL: 4 };
const VC_SEVERITY: Record<Severity, number> = { INFO: 100, WARNING: 400, MAJOR: 700, CRITICAL: 900 };

function severityFromVbLevel(level: number): Severity {
  return (Object.keys(VB_LEVEL) as Severity[]).find((s) => VB_LEVEL[s] === level) ?? "WARNING";
}

function severityFromOpcUa(sev: number): Severity {
  if (sev >= 800) return "CRITICAL";
  if (sev >= 600) return "MAJOR";
  if (sev >= 300) return "WARNING";
  return "INFO";
}

/** SEMI E5 ALCD: bit 8 = set, low bits = category. */
function alcdFor(category: AlarmCategory, severity: Severity, set: boolean): number {
  const cat =
    category === "SAFETY"
      ? 1
      : category === "PROCESS"
        ? severity === "WARNING"
          ? 3
          : 4
        : category === "UTILITY"
          ? 6
          : 5;
  return (set ? 0x80 : 0) | cat;
}

/** "ns=2;s=CVD-01/PM1" → ["CVD-01", "PM1"] */
const nodePath = (nodeId: string) => (nodeId.match(/;s=(.*)$/)?.[1] ?? "").split("/");

const vbAlarmCode = (alid: number) => `E${(alid + 0x1000).toString(16).toUpperCase()}`;
const vcAlarmCode = (alid: number, category: AlarmCategory) => `KT-${category.slice(0, 4)}-${alid}`;

// -------------------------------------------------------------- SECS-II

type SecsItem =
  | { t: "L"; v: SecsItem[] }
  | { t: "A"; v: string }
  | { t: "U4" | "F4" | "B"; v: number };

const L = (...v: SecsItem[]): SecsItem => ({ t: "L", v });
const A = (v: string): SecsItem => ({ t: "A", v });
const U4 = (v: number): SecsItem => ({ t: "U4", v });
const F4 = (v: number): SecsItem => ({ t: "F4", v: Math.fround(v) });
const B = (v: number): SecsItem => ({ t: "B", v });

function sml(item: SecsItem, indent = 0): string {
  const pad = "  ".repeat(indent);
  switch (item.t) {
    case "L":
      if (!item.v.length) return `${pad}<L[0]>`;
      return `${pad}<L[${item.v.length}]\n${item.v.map((c) => sml(c, indent + 1)).join("\n")}\n${pad}>`;
    case "A":
      return `${pad}<A "${item.v}">`;
    case "B":
      return `${pad}<B 0x${item.v.toString(16).padStart(2, "0").toUpperCase()}>`;
    case "F4":
      return `${pad}<F4 ${Number(item.v.toPrecision(7))}>`;
    default:
      return `${pad}<${item.t} ${item.v}>`;
  }
}

const secsValue = (v: string | number): SecsItem =>
  typeof v === "number" ? (Number.isInteger(v) ? U4(v) : F4(v)) : A(v);

const itemValue = (item: SecsItem): string | number => {
  if (item.t === "A") return item.v;
  if (item.t === "L") return "";
  return item.t === "F4" ? Number(item.v.toPrecision(7)) : item.v;
};

function stime(ts: number): string {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    p2(d.getUTCMonth() + 1) +
    p2(d.getUTCDate()) +
    p2(d.getUTCHours()) +
    p2(d.getUTCMinutes()) +
    p2(d.getUTCSeconds()) +
    p2(Math.floor(d.getUTCMilliseconds() / 10))
  );
}

// ------------------------------------------------------------------ XML

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlUnescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = xmlUnescape(m[2]);
  return out;
}

const num7 = (v: number) => String(Number(v.toPrecision(7)));

// --------------------------------------------------------------- context

const CONTEXT_VARS = ["RunID", "LotID", "WaferIDs", "RecipeID", "StepNo", "StepName"] as const;
const CONTEXT_SVID_BASE = 90;

function contextValues(ctx: RunContext | null): string[] {
  if (!ctx) return ["", "", "", "", "", ""];
  return [ctx.runId, ctx.lotId, ctx.waferIds.join(","), ctx.recipeId, String(ctx.stepNo), ctx.stepName];
}

function contextFrom(values: string[]): RunContext | null {
  if (!values[0]) return null;
  return {
    runId: values[0],
    lotId: values[1],
    waferIds: values[2] ? values[2].split(",") : [],
    recipeId: values[3],
    stepNo: Number(values[4]),
    stepName: values[5],
  };
}

// ------------------------------------------------------------ the link

interface TraceDef {
  trid: number;
  chamberId: string;
  keys: string[];
  signature: string;
}

const MAX_FRAMES = 160;
const MAX_TRACE_FRAMES = 24;

/**
 * One equipment's connection: vendor driver on one end, unified adapter on
 * the other. Host-side definitions (trace and report layouts) live here, as
 * they would after S2F23/S2F33/S2F35 on a real GEM link.
 */
export class VendorLink {
  private eq!: EquipmentConfig;
  private byChamberKey = new Map<string, ParamMapping>();
  private byNative = new Map<string, ParamMapping>();
  mappings: ParamMapping[] = [];
  private traceDefs = new Map<string, TraceDef>();
  private reportDefs = new Map<number, string[]>();
  private frameLog: NativeFrame[] = [];
  private traceLog: NativeFrame[] = [];
  private seq = 0;
  private dataId = 0;
  decodeErrors = 0;

  constructor(eq: EquipmentConfig) {
    this.reconfigure(eq);
  }

  get vendor(): VendorId {
    return this.eq.vendor;
  }

  reconfigure(eq: EquipmentConfig) {
    this.eq = eq;
    this.mappings = buildMappings(eq);
    this.byChamberKey.clear();
    this.byNative.clear();
    for (const m of this.mappings) {
      this.byChamberKey.set(`${m.chamberId}|${m.key}`, m);
      this.byNative.set(m.nativeName, m);
    }
    this.traceDefs.clear();
    this.reportDefs.clear();
  }

  frames(): NativeFrame[] {
    return [...this.frameLog, ...this.traceLog].sort((a, b) => a.seq - b.seq);
  }

  private record(frame: Omit<NativeFrame, "seq" | "vendor" | "protocol">) {
    const full: NativeFrame = { ...frame, seq: ++this.seq, vendor: this.eq.vendor, protocol: VENDORS[this.eq.vendor].protocol };
    const log = frame.kind === "trace" ? this.traceLog : this.frameLog;
    log.push(full);
    if (log.length > (frame.kind === "trace" ? MAX_TRACE_FRAMES : MAX_FRAMES)) log.shift();
  }

  private mapping(chamberId: string, key: string): ParamMapping {
    const m = this.byChamberKey.get(`${chamberId}|${key}`);
    if (!m) throw new Error(`no mapping for ${chamberId}/${key}`);
    return m;
  }

  private toNative(key: string, v: number): number {
    const def = this.eq.parameters.find((p) => p.key === key)!;
    return unitConv(this.eq.vendor, def.unit).to(v);
  }

  private fromNative(key: string, v: number): number {
    const def = this.eq.parameters.find((p) => p.key === key)!;
    return unitConv(this.eq.vendor, def.unit).from(v);
  }

  // -------------------------------------------------------------- trace

  trace(t: TracePayload, ts: number): TracePayload {
    const keys = Object.keys(t.values);
    switch (this.eq.vendor) {
      case "VA":
        return this.traceVA(t, keys, ts);
      case "VB":
        return this.traceVB(t, keys, ts);
      case "VC":
        return this.traceVC(t, keys, ts);
    }
  }

  private traceDef(chamberId: string, keys: string[], ts: number): TraceDef {
    const signature = keys.join(",");
    const existing = this.traceDefs.get(chamberId);
    if (existing && existing.signature === signature) return existing;
    const trid = this.eq.chambers.indexOf(chamberId) + 1;
    const def: TraceDef = { trid, chamberId, keys, signature };
    this.traceDefs.set(chamberId, def);
    const svids = [
      ...CONTEXT_VARS.map((_, i) => CONTEXT_SVID_BASE + i),
      ...keys.map((k) => this.mapping(chamberId, k).svid),
      ...keys.map((k) => this.mapping(chamberId, k).svid + 5000),
    ];
    const body = L(A(String(trid)), A(""), U4(1), U4(1), L(...svids.map(U4)));
    this.record({
      ts,
      direction: "H→E",
      kind: "trace",
      summary: `S2F23 Trace Initialize TRID=${trid} (${chamberId}, ${svids.length} SVIDs)`,
      text: `S2F23 W\n${sml(body)}.`,
    });
    return def;
  }

  private traceVA(t: TracePayload, keys: string[], ts: number): TracePayload {
    const def = this.traceDef(t.chamberId, keys, ts);
    const body = L(
      U4(def.trid),
      U4(t.sampleNo),
      A(stime(ts)),
      L(
        ...contextValues(t.context).map(A),
        ...keys.map((k) => F4(this.toNative(k, t.values[k]))),
        ...keys.map((k) => F4(this.toNative(k, t.setpoints[k] ?? 0))),
      ),
    );
    this.record({
      ts,
      direction: "E→H",
      kind: "trace",
      summary: `S6F1 Trace Data TRID=${def.trid} SMPLN=${t.sampleNo}`,
      text: `S6F1 W\n${sml(body)}.`,
    });
    // Adapter: positional decode using the trace definition.
    const [tridItem, smplnItem, , list] = (body as { v: SecsItem[] }).v;
    const d = [...this.traceDefs.values()].find((x) => x.trid === tridItem.v)!;
    const vals = (list as { v: SecsItem[] }).v;
    const ctx = contextFrom(vals.slice(0, CONTEXT_VARS.length).map((i) => String(itemValue(i))));
    const values: Record<string, number> = {};
    const setpoints: Record<string, number> = {};
    d.keys.forEach((k, i) => {
      values[k] = this.fromNative(k, Number(itemValue(vals[CONTEXT_VARS.length + i])));
      setpoints[k] = this.fromNative(k, Number(itemValue(vals[CONTEXT_VARS.length + d.keys.length + i])));
    });
    return { eqpId: this.eq.id, chamberId: d.chamberId, sampleNo: Number(smplnItem.v), context: ctx, values, setpoints };
  }

  private traceVB(t: TracePayload, keys: string[], ts: number): TracePayload {
    const c = contextValues(t.context);
    const params = keys
      .map((k) => {
        const m = this.mapping(t.chamberId, k);
        return `  <P n="${m.nativeName}" u="${m.nativeUnit}" sp="${num7(this.toNative(k, t.setpoints[k] ?? 0))}">${num7(this.toNative(k, t.values[k]))}</P>`;
      })
      .join("\n");
    const xml =
      `<TraceData tool="${this.eq.id}" module="${t.chamberId}" seq="${t.sampleNo}" time="${new Date(ts).toISOString()}">\n` +
      `  <Ctx run="${xmlEscape(c[0])}" lot="${xmlEscape(c[1])}" wafers="${xmlEscape(c[2])}" recipe="${xmlEscape(c[3])}" step="${c[4]}" stepName="${xmlEscape(c[5])}"/>\n` +
      `${params}\n</TraceData>`;
    this.record({ ts, direction: "E→H", kind: "trace", summary: `TraceData ${t.chamberId} seq=${t.sampleNo}`, text: xml });
    // Adapter: parse the XML text.
    const head = xmlAttrs(xml.match(/<TraceData [^>]*>/)![0]);
    const ctxAttrs = xmlAttrs(xml.match(/<Ctx [^>]*\/>/)![0]);
    const values: Record<string, number> = {};
    const setpoints: Record<string, number> = {};
    for (const m of xml.matchAll(/<P ([^>]*)>([^<]*)<\/P>/g)) {
      const a = xmlAttrs(m[1]);
      const map = this.byNative.get(a.n);
      if (!map) {
        this.decodeErrors++;
        continue;
      }
      values[map.key] = this.fromNative(map.key, Number(m[2]));
      setpoints[map.key] = this.fromNative(map.key, Number(a.sp));
    }
    return {
      eqpId: head.tool,
      chamberId: head.module,
      sampleNo: Number(head.seq),
      context: contextFrom([ctxAttrs.run, ctxAttrs.lot, ctxAttrs.wafers, ctxAttrs.recipe, ctxAttrs.step, ctxAttrs.stepName]),
      values,
      setpoints,
    };
  }

  private traceVC(t: TracePayload, keys: string[], ts: number): TracePayload {
    const c = contextValues(t.context);
    const time = new Date(ts).toISOString();
    const msg = {
      SubscriptionId: this.eq.chambers.indexOf(t.chamberId) + 1,
      SequenceNumber: t.sampleNo,
      Context: { RunId: c[0], LotId: c[1], WaferIds: c[2], RecipeId: c[3], StepNo: c[4], StepName: c[5] },
      MonitoredItems: keys.map((k) => {
        const m = this.mapping(t.chamberId, k);
        return {
          NodeId: m.nativeName,
          Value: this.toNative(k, t.values[k]),
          Setpoint: this.toNative(k, t.setpoints[k] ?? 0),
          EngUnit: m.nativeUnit,
          SourceTimestamp: time,
        };
      }),
    };
    const text = JSON.stringify(msg);
    this.record({
      ts,
      direction: "E→H",
      kind: "trace",
      summary: `DataChangeNotification sub=${msg.SubscriptionId} seq=${t.sampleNo}`,
      text: JSON.stringify(msg, null, 1),
    });
    // Adapter: parse the JSON text.
    const parsed = JSON.parse(text) as typeof msg;
    const values: Record<string, number> = {};
    const setpoints: Record<string, number> = {};
    let chamberId = t.chamberId;
    for (const item of parsed.MonitoredItems) {
      const map = this.byNative.get(item.NodeId);
      if (!map) {
        this.decodeErrors++;
        continue;
      }
      chamberId = map.chamberId;
      values[map.key] = this.fromNative(map.key, item.Value);
      setpoints[map.key] = this.fromNative(map.key, item.Setpoint);
    }
    const x = parsed.Context;
    return {
      eqpId: this.eq.id,
      chamberId,
      sampleNo: parsed.SequenceNumber,
      context: contextFrom([x.RunId, x.LotId, x.WaferIds, x.RecipeId, x.StepNo, x.StepName]),
      values,
      setpoints,
    };
  }

  // -------------------------------------------------------------- events

  event(e: EventPayload, ts: number): EventPayload {
    switch (this.eq.vendor) {
      case "VA":
        return this.eventVA(e, ts);
      case "VB":
        return this.eventVB(e, ts);
      case "VC":
        return this.eventVC(e, ts);
    }
  }

  private eventVA(e: EventPayload, ts: number): EventPayload {
    const ceid = ceidFor("VA", e.name);
    const reports = e.reports.map((r, i) => {
      const rptid = ceid * 10 + i + 1;
      const vars = Object.keys(r.values);
      const known = this.reportDefs.get(rptid);
      if (!known || known.join(",") !== vars.join(",")) {
        this.reportDefs.set(rptid, vars);
        const def = L(U4(++this.dataId), L(L(U4(rptid), L(...vars.map(A)))));
        this.record({
          ts,
          direction: "H→E",
          kind: "event",
          summary: `S2F33/S2F35 Define & Link Report RPTID=${rptid} → CEID=${ceid}`,
          text: `S2F33 W\n${sml(def)}.`,
        });
      }
      return L(U4(rptid), L(...vars.map((v) => secsValue(r.values[v]))));
    });
    const body = L(U4(++this.dataId), U4(ceid), L(...reports));
    this.record({
      ts,
      direction: "E→H",
      kind: "event",
      summary: `S6F11 Event Report CEID=${ceid}${e.chamberId ? ` (${e.chamberId})` : ""}`,
      text: `S6F11 W\n${sml(body)}.`,
    });
    // Adapter: CEID → canonical event name, report values by definition.
    const [, ceidItem, rptList] = (body as { v: SecsItem[] }).v;
    const name = eventNameByCeid("VA", Number(ceidItem.v));
    if (!name) {
      this.decodeErrors++;
      return e;
    }
    const decoded: EventReport[] = (rptList as { v: SecsItem[] }).v.map((rpt) => {
      const [idItem, valList] = (rpt as { v: SecsItem[] }).v;
      const vars = this.reportDefs.get(Number(idItem.v)) ?? [];
      const values: Record<string, string | number> = {};
      (valList as { v: SecsItem[] }).v.forEach((it, i) => (values[vars[i] ?? `V${i}`] = itemValue(it)));
      return { rptid: Number(idItem.v), values };
    });
    const chamberId = decoded[0]?.values.ChamberID ? String(decoded[0].values.ChamberID) : null;
    return { eqpId: this.eq.id, ceid: Number(ceidItem.v), name, chamberId, reports: decoded };
  }

  private eventVB(e: EventPayload, ts: number): EventPayload {
    const ceid = ceidFor("VB", e.name);
    const reports = e.reports
      .map((r, i) => {
        const data = Object.entries(r.values)
          .map(([k, v]) =>
            typeof v === "number"
              ? `    <D n="${k}" type="num">${num7(v)}</D>`
              : `    <D n="${k}">${xmlEscape(v)}</D>`,
          )
          .join("\n");
        return `  <Report id="${ceid * 10 + i + 1}">\n${data}\n  </Report>`;
      })
      .join("\n");
    const xml =
      `<Event name="${VB_EVENT_NAMES[e.name]}" id="${ceid}" tool="${this.eq.id}" module="${e.chamberId ?? ""}" time="${new Date(ts).toISOString()}">\n` +
      `${reports}\n</Event>`;
    this.record({ ts, direction: "E→H", kind: "event", summary: `Event ${VB_EVENT_NAMES[e.name]}`, text: xml });
    // Adapter
    const head = xmlAttrs(xml.match(/<Event [^>]*>/)![0]);
    const name = (Object.keys(VB_EVENT_NAMES) as EventName[]).find((n) => VB_EVENT_NAMES[n] === head.name);
    if (!name) {
      this.decodeErrors++;
      return e;
    }
    const decoded: EventReport[] = [];
    for (const rm of xml.matchAll(/<Report id="(\d+)">([\s\S]*?)<\/Report>/g)) {
      const values: Record<string, string | number> = {};
      for (const dm of rm[2].matchAll(/<D ([^>]*)>([^<]*)<\/D>/g)) {
        const a = xmlAttrs(dm[1]);
        values[a.n] = a.type === "num" ? Number(dm[2]) : xmlUnescape(dm[2]);
      }
      decoded.push({ rptid: Number(rm[1]), values });
    }
    return { eqpId: head.tool, ceid: Number(head.id), name, chamberId: head.module || null, reports: decoded };
  }

  private eventVC(e: EventPayload, ts: number): EventPayload {
    const ceid = ceidFor("VC", e.name);
    const msg = {
      EventType: `ns=2;i=${ceid}`,
      EventName: `${pascal(e.name.toLowerCase())}Event`,
      SourceNode: `ns=2;s=${this.eq.id}${e.chamberId ? `/${e.chamberId}` : ""}`,
      Time: new Date(ts).toISOString(),
      Fields: e.reports.map((r, i) => ({ ReportId: ceid * 10 + i + 1, Values: r.values })),
    };
    const text = JSON.stringify(msg, null, 1);
    this.record({ ts, direction: "E→H", kind: "event", summary: `Event ${msg.EventName}`, text });
    // Adapter
    const parsed = JSON.parse(text) as typeof msg;
    const id = Number(parsed.EventType.split("i=")[1]);
    const name = eventNameByCeid("VC", id);
    if (!name) {
      this.decodeErrors++;
      return e;
    }
    const source = nodePath(parsed.SourceNode);
    return {
      eqpId: source[0],
      ceid: id,
      name,
      chamberId: source[1] ?? null,
      reports: parsed.Fields.map((f) => ({ rptid: f.ReportId, values: f.Values })),
    };
  }

  // -------------------------------------------------------------- alarms

  alarm(a: AlarmPayload, ts: number): AlarmPayload {
    switch (this.eq.vendor) {
      case "VA":
        return this.alarmVA(a, ts);
      case "VB":
        return this.alarmVB(a, ts);
      case "VC":
        return this.alarmVC(a, ts);
    }
  }

  private lookupAlarm(alid: number) {
    return this.eq.alarms.find((x) => x.alid === alid);
  }

  private alarmVA(a: AlarmPayload, ts: number): AlarmPayload {
    const text = a.chamberId ? `[${a.chamberId}] ${a.text}` : a.text;
    const body = L(B(alcdFor(a.category, a.severity, a.set)), U4(a.alid), A(text.slice(0, 120)));
    this.record({
      ts,
      direction: "E→H",
      kind: "alarm",
      summary: `S5F1 Alarm ${a.set ? "SET" : "CLEAR"} ALID=${a.alid}`,
      text: `S5F1 W\n${sml(body)}.`,
    });
    const [alcd, alid, altx] = (body as { v: SecsItem[] }).v;
    const def = this.lookupAlarm(Number(alid.v));
    const chamber = String(altx.v).match(/^\[([^\]]+)\] /);
    return {
      eqpId: this.eq.id,
      chamberId: chamber ? chamber[1] : null,
      alid: Number(alid.v),
      code: def?.code ?? `ALID-${alid.v}`,
      text: def?.text ?? String(altx.v),
      severity: def?.severity ?? "WARNING",
      category: def?.category ?? "HARDWARE",
      set: (Number(alcd.v) & 0x80) !== 0,
    };
  }

  private alarmVB(a: AlarmPayload, ts: number): AlarmPayload {
    const xml =
      `<Alarm tool="${this.eq.id}" module="${a.chamberId ?? ""}" code="${vbAlarmCode(a.alid)}" ` +
      `state="${a.set ? "SET" : "CLEAR"}" level="${VB_LEVEL[a.severity]}" time="${new Date(ts).toISOString()}">${xmlEscape(a.text)}</Alarm>`;
    this.record({ ts, direction: "E→H", kind: "alarm", summary: `Alarm ${vbAlarmCode(a.alid)} ${a.set ? "SET" : "CLEAR"}`, text: xml });
    const m = xml.match(/<Alarm ([^>]*)>([^<]*)<\/Alarm>/)!;
    const attrs = xmlAttrs(m[1]);
    const alid = parseInt(attrs.code.slice(1), 16) - 0x1000;
    const def = this.lookupAlarm(alid);
    return {
      eqpId: attrs.tool,
      chamberId: attrs.module || null,
      alid,
      code: def?.code ?? attrs.code,
      text: xmlUnescape(m[2]),
      severity: severityFromVbLevel(Number(attrs.level)),
      category: def?.category ?? "HARDWARE",
      set: attrs.state === "SET",
    };
  }

  private alarmVC(a: AlarmPayload, ts: number): AlarmPayload {
    const msg = {
      EventName: "AlarmConditionEvent",
      ConditionId: vcAlarmCode(a.alid, a.category),
      SourceNode: `ns=2;s=${this.eq.id}${a.chamberId ? `/${a.chamberId}` : ""}`,
      Severity: VC_SEVERITY[a.severity],
      ActiveState: a.set,
      Message: a.text,
      Time: new Date(ts).toISOString(),
    };
    const text = JSON.stringify(msg, null, 1);
    this.record({ ts, direction: "E→H", kind: "alarm", summary: `AlarmCondition ${msg.ConditionId} ${a.set ? "Active" : "Inactive"}`, text });
    const parsed = JSON.parse(text) as typeof msg;
    const alid = Number(parsed.ConditionId.split("-").pop());
    const def = this.lookupAlarm(alid);
    const source = nodePath(parsed.SourceNode);
    return {
      eqpId: source[0],
      chamberId: source[1] ?? null,
      alid,
      code: def?.code ?? parsed.ConditionId,
      text: parsed.Message,
      severity: severityFromOpcUa(parsed.Severity),
      category: def?.category ?? "HARDWARE",
      set: parsed.ActiveState,
    };
  }

  // ------------------------------------------------------------ commands

  command(cmd: CommandPayload, result: CommandResult, ts: number) {
    const args = cmd.args ?? {};
    switch (this.eq.vendor) {
      case "VA": {
        const body = L(A(cmd.action), L(...Object.entries(args).map(([k, v]) => L(A(k), secsValue(String(v))))));
        const hcack = result.ok ? 0 : cmd.origin === "HOST" ? 1 : 3;
        this.record({
          ts,
          direction: "H→E",
          kind: "command",
          summary: `S2F41 Host Command ${cmd.action} → S2F42 HCACK=${hcack}`,
          text: `S2F41 W\n${sml(body)}.\n\nS2F42\n${sml(L(B(hcack), L()))}.`,
        });
        break;
      }
      case "VB": {
        const attrs = Object.entries(args)
          .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
          .join("");
        this.record({
          ts,
          direction: "H→E",
          kind: "command",
          summary: `Command ${cmd.action} → ${result.ok ? "ACK" : "NAK"}`,
          text: `<Command name="${cmd.action}" tool="${this.eq.id}" from="${cmd.requestedBy}"${attrs}/>\n<Reply result="${result.ok ? "ACK" : "NAK"}">${xmlEscape(result.message)}</Reply>`,
        });
        break;
      }
      case "VC": {
        const msg = {
          ObjectId: `ns=2;s=${this.eq.id}/Methods`,
          MethodId: `ns=2;s=${this.eq.id}/Methods/${pascal(cmd.action.toLowerCase())}`,
          InputArguments: args,
          StatusCode: result.ok ? "Good" : "BadInvalidState",
          Message: result.message,
        };
        this.record({
          ts,
          direction: "H→E",
          kind: "command",
          summary: `Call ${pascal(cmd.action.toLowerCase())} → ${msg.StatusCode}`,
          text: JSON.stringify(msg, null, 1),
        });
        break;
      }
    }
  }
}
