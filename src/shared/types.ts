// Canonical (vendor-neutral) domain model shared by the simulator, the four
// fab systems and the unified UI. Every vendor-specific name, unit, code and
// frame format is translated into these types by the unified adapter layer.

export type EquipmentType = "ETCH" | "CVD" | "PVD" | "CMP" | "DIFF";
export type VendorId = "VA" | "VB" | "VC";

/** SEMI E10 equipment states. */
export type E10State = "PRD" | "SBY" | "ENG" | "SDT" | "UDT" | "NST";
/** SEMI E30 (GEM) control state. */
export type ControlState = "OFFLINE" | "ONLINE_LOCAL" | "ONLINE_REMOTE";
export type ProcessState = "IDLE" | "EXECUTING" | "PAUSED";
export type ChamberState = "IDLE" | "PROCESSING" | "PAUSED" | "DOWN" | "PM";
export type EquipmentMode = "PRODUCTION" | "ENGINEERING" | "NONSCHEDULED";

export type Severity = "INFO" | "WARNING" | "MAJOR" | "CRITICAL";
export const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  WARNING: 1,
  MAJOR: 2,
  CRITICAL: 3,
};

export type CanonicalUnit =
  | "W"
  | "kW"
  | "V"
  | "A"
  | "mTorr"
  | "Torr"
  | "°C"
  | "sccm"
  | "%"
  | "rpm"
  | "psi"
  | "ml/min";

export interface ParameterDef {
  key: string;
  name: string;
  unit: CanonicalUnit;
  /** Value the parameter settles to when no recipe step drives it. */
  idle: number;
  /** Sensor noise, 1 sigma, canonical units. */
  noise: number;
  /** First-order response time constant (s). */
  tau: number;
  min: number;
  max: number;
  /** Allowed |actual - setpoint| once settled; the equipment's own interlock uses 5x this. */
  tolerance: number;
  /** Visible chamber aging: offset = setpoint * driftPerWafer * wafersSincePm * aging. */
  aging?: number;
}

export interface RecipeStep {
  name: string;
  /** Seconds. */
  duration: number;
  /** Parameters not listed fall back to their idle value. */
  setpoints: Record<string, number>;
}

export interface Recipe {
  id: string;
  name: string;
  steps: RecipeStep[];
}

export type AlarmCategory = "PROCESS" | "HARDWARE" | "TRANSFER" | "SAFETY" | "UTILITY";

export interface AlarmDef {
  /** Canonical alarm code, identical across vendors. */
  code: string;
  alid: number;
  text: string;
  severity: Severity;
  category: AlarmCategory;
  /** Stops all chambers (equipment goes UDT) until the alarm is reset. */
  stopsEquipment: boolean;
  /** Clears by itself after this many seconds (warnings). */
  autoClearSec?: number;
  /** Raised by the equipment's own interlock when this parameter leaves 5x tolerance. */
  param?: string;
}

export interface MetrologyItemDef {
  key: string;
  name: string;
  unit: string;
  target: number;
  usl?: number;
  lsl?: number;
  noise: number;
  /** value = target * (1 + sum(coef * relDev[param])); relDev = mean (actual - sp) / max |sp| in the recipe. */
  sensitivity: Record<string, number>;
  /** Use |relDev| (uniformity-like items get worse in either direction). */
  absolute?: boolean;
  /** Hidden chamber aging FDC cannot see: value *= 1 + aging * driftPerWafer * wafersSincePm. */
  aging?: number;
}

export const EVENT_NAMES = [
  "CONTROL_STATE_CHANGED",
  "EQUIPMENT_STATE_CHANGED",
  "CARRIER_ARRIVED",
  "LOT_START",
  "LOT_END",
  "CARRIER_REMOVED",
  "PROCESS_START",
  "PROCESS_END",
  "STEP_START",
  "STEP_END",
  "PROCESS_PAUSED",
  "PROCESS_RESUMED",
  "PROCESS_ABORTED",
  "ALARM_SET",
  "ALARM_CLEARED",
  "PM_START",
  "PM_END",
  "REMOTE_COMMAND",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export interface GenerationConfig {
  traceEnabled: boolean;
  /** Trace sampling period in simulated milliseconds. */
  traceIntervalMs: number;
  /** Keep reporting trace while a chamber is idle. */
  traceIdle: boolean;
  /** Parameter keys to report; empty = all. */
  traceParams: string[];
  noiseScale: number;
  /** Chamber aging per processed wafer, as a fraction of setpoint. */
  driftPerWafer: number;
  eventsEnabled: Record<EventName, boolean>;
  /** Extra status variables (parameter keys) attached to each event report. */
  eventReportVars: Partial<Record<EventName, string[]>>;
  /** Random (non-interlock) alarms per simulated hour. */
  alarmRatePerHour: number;
  /** Technician auto-reset of stopping alarms after N seconds; 0 = wait for the operator. */
  autoRecoverSec: number;
  /** Host (MES) feeds lots automatically while ONLINE_REMOTE. */
  autoRun: boolean;
  lotIntervalSec: number;
  wafersPerLot: number;
  defaultRecipeId: string;
  /** Fraction of processed wafers sent to metrology (QMS). */
  metrologyRate: number;
  /** Wafer exchange time between runs on a chamber. */
  transferSec: number;
  /** Automatic preventive maintenance after this many wafers per chamber; 0 = off. */
  pmIntervalWafers: number;
  pmDurationSec: number;
}

export interface EquipmentConfig {
  id: string;
  name: string;
  type: EquipmentType;
  vendor: VendorId;
  model: string;
  area: string;
  chambers: string[];
  loadPorts: number;
  /** single: one wafer per run; batch: the whole lot per run (furnaces). */
  processMode: "single" | "batch";
  parameters: ParameterDef[];
  recipes: Recipe[];
  alarms: AlarmDef[];
  metrology: MetrologyItemDef[];
  generation: GenerationConfig;
}

export type FaultType = "SHIFT" | "DRIFT" | "SPIKE" | "NOISE" | "STUCK" | "DROPOUT";

export interface FaultInjection {
  id: string;
  eqpId: string;
  /** Chamber id, or "*" for every chamber. */
  chamberId: string;
  param: string;
  type: FaultType;
  /**
   * SHIFT: offset (units). DRIFT: units per simulated minute. SPIKE: amplitude.
   * NOISE: sigma multiplier. STUCK: ignored. DROPOUT: ignored.
   */
  magnitude: number;
  /** SPIKE / DROPOUT: chance per sample (0..1). */
  probability: number;
  /** Only affects samples taken while a recipe step is running. */
  processOnly: boolean;
  enabled: boolean;
  /** Simulated time the fault became active. */
  startedAt: number;
  /** Auto-remove after N simulated seconds; 0 = until removed. */
  durationSec: number;
  note?: string;
}

// ---------------------------------------------------------------- runtime

export type SlotState = "EMPTY" | "WAITING" | "PROCESSING" | "DONE" | "ABORTED";

export interface RunContext {
  runId: string;
  lotId: string;
  waferIds: string[];
  recipeId: string;
  stepNo: number;
  stepName: string;
}

export interface ChamberStatus {
  id: string;
  state: ChamberState;
  run: RunContext | null;
  stepElapsed: number;
  stepDuration: number;
  runElapsed: number;
  runDuration: number;
  values: Record<string, number>;
  setpoints: Record<string, number>;
  wafersSincePm: number;
}

export interface LoadPortStatus {
  id: number;
  state: "EMPTY" | "LOADED" | "PROCESSING" | "COMPLETE";
  carrierId: string | null;
  lotId: string | null;
  recipeId: string | null;
  slots: SlotState[];
}

export interface ActiveAlarm {
  code: string;
  alid: number;
  text: string;
  severity: Severity;
  chamberId: string | null;
  setAt: number;
  stopsEquipment: boolean;
}

export interface EquipmentStatus {
  id: string;
  controlState: ControlState;
  processState: ProcessState;
  e10: E10State;
  e10Since: number;
  mode: EquipmentMode;
  pm: boolean;
  chambers: ChamberStatus[];
  loadPorts: LoadPortStatus[];
  activeAlarms: ActiveAlarm[];
  wafersProcessed: number;
  lotsProcessed: number;
  holdReason: string | null;
}

// --------------------------------------------------------------- messages

export type MessageKind =
  | "info"
  | "trace"
  | "event"
  | "alarm"
  | "state"
  | "link"
  | "metrology"
  | "command"
  | "fdc.alarm"
  | "fdc.run"
  | "qms.alarm"
  | "qms.lot"
  | "ees.alarm"
  | "ams.alarm"
  | "ams.notify";

export interface Envelope<T = unknown> {
  id: number;
  topic: string;
  kind: MessageKind;
  /** Simulated epoch milliseconds. */
  ts: number;
  source: string;
  payload: T;
}

/** Equipment master data, published to the systems on start and on every config change. */
export interface EquipmentInfoPayload {
  eqpId: string;
  removed?: boolean;
  name: string;
  type: EquipmentType;
  vendor: VendorId;
  model: string;
  area: string;
  chambers: string[];
  processMode: "single" | "batch";
  parameters: Array<Pick<ParameterDef, "key" | "name" | "unit" | "tolerance" | "min" | "max">>;
  recipes: Array<{ id: string; name: string; steps: Array<{ name: string; duration: number }> }>;
  metrology: Array<Pick<MetrologyItemDef, "key" | "name" | "unit" | "target" | "usl" | "lsl">>;
}

export interface TracePayload {
  eqpId: string;
  chamberId: string;
  sampleNo: number;
  context: RunContext | null;
  values: Record<string, number>;
  setpoints: Record<string, number>;
}

export interface EventReport {
  rptid: number;
  values: Record<string, string | number>;
}

/** ERD — Event Report Data (S6F11-equivalent, vendor neutral). */
export interface EventPayload {
  eqpId: string;
  ceid: number;
  name: EventName;
  chamberId: string | null;
  reports: EventReport[];
}

export interface AlarmPayload {
  eqpId: string;
  chamberId: string | null;
  alid: number;
  code: string;
  text: string;
  severity: Severity;
  category: AlarmCategory;
  set: boolean;
}

export interface StatePayload {
  eqpId: string;
  e10: E10State;
  prevE10: E10State;
  controlState: ControlState;
  processState: ProcessState;
  reason: string;
}

export interface LinkPayload {
  eqpId: string;
  online: boolean;
  controlState: ControlState;
}

export interface MetrologyValue {
  key: string;
  name: string;
  unit: string;
  value: number;
  target: number;
  usl?: number;
  lsl?: number;
}

export interface MetrologyPayload {
  eqpId: string;
  eqpType: EquipmentType;
  chamberId: string;
  runId: string;
  lotId: string;
  waferId: string;
  recipeId: string;
  items: MetrologyValue[];
}

export type CommandAction =
  | "ONLINE_REMOTE"
  | "ONLINE_LOCAL"
  | "OFFLINE"
  | "LOAD_CARRIER"
  | "START_LOT"
  | "UNLOAD_CARRIER"
  | "PAUSE"
  | "RESUME"
  | "ABORT"
  | "ALARM_RESET"
  | "RAISE_ALARM"
  | "PM_START"
  | "PM_END"
  | "SET_MODE"
  | "HOLD"
  | "RELEASE_HOLD";

export interface CommandPayload {
  eqpId: string;
  action: CommandAction;
  args?: Record<string, string | number | boolean>;
  /** LOCAL = operator at the equipment UI, HOST = a fab system (needs ONLINE_REMOTE). */
  origin: "LOCAL" | "HOST";
  requestedBy: string;
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

export type FaultClass = "SHIFT" | "DRIFT" | "SPIKE" | "NOISE" | "STUCK" | "OUT_OF_SPEC";

export interface FdcAlarmPayload {
  eqpId: string;
  chamberId: string;
  runId: string;
  lotId: string;
  waferIds: string[];
  recipeId: string;
  stepNo: number;
  stepName: string;
  param: string;
  indicator: string;
  value: number;
  lcl: number;
  ucl: number;
  faultClass: FaultClass;
  severity: Severity;
  interlock: boolean;
  message: string;
}

export interface FdcRunPayload {
  eqpId: string;
  chamberId: string;
  runId: string;
  lotId: string;
  waferIds: string[];
  recipeId: string;
  status: "OK" | "WARN" | "FAULT" | "LEARNING" | "ABORTED";
  faultCount: number;
}

export interface SystemAlarmPayload {
  eqpId: string;
  code: string;
  text: string;
  severity: Severity;
  /** Lets AMS clear a system alarm when the condition goes away. */
  set: boolean;
  context?: Record<string, string | number>;
}

export interface QmsLotPayload {
  lotId: string;
  eqpId: string;
  status: "HOLD" | "RELEASED" | "SCRAPPED" | "REWORK";
  reason: string;
}

// --------------------------------------------------------------- sim info

export interface SimStatus {
  running: boolean;
  speed: number;
  simTime: number;
  startedAt: number;
  seed: number;
  tick: number;
}

export interface ParamMapping {
  key: string;
  name: string;
  chamberId: string;
  svid: number;
  nativeName: string;
  canonicalUnit: CanonicalUnit;
  nativeUnit: string;
}

export interface NativeFrame {
  seq: number;
  ts: number;
  vendor: VendorId;
  protocol: string;
  direction: "E→H" | "H→E";
  kind: "trace" | "event" | "alarm" | "command";
  summary: string;
  text: string;
}
