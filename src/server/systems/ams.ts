import type { AlarmPayload, Envelope, FdcAlarmPayload, Severity, SystemAlarmPayload } from "../../shared/types";
import { SEVERITY_RANK } from "../../shared/types";
import { topics } from "../../shared/topics";
import type { MessageBus } from "../bus/message-bus";
import type { FabSystem } from "./common";
import { matchesFilter, pushRing, round } from "./common";

// AMS — Alarm Management System.
// One place for every alarm in the fab: equipment alarms (S5F1 equivalent),
// FDC faults, QMS quality alarms and EES equipment alerts. Handles the alarm
// lifecycle (active → acknowledged → cleared/closed), de-duplication,
// notification routing to on-call groups, time-based escalation, shelving and
// alarm flood detection.

export type AlarmSource = "EQP" | "FDC" | "QMS" | "EES" | "AMS";
export type AlarmState = "ACTIVE" | "ACKED" | "CLEARED" | "CLOSED";
export type Channel = "MESSENGER" | "SMS" | "EMAIL";

export interface AmsAlarm {
  id: number;
  key: string;
  source: AlarmSource;
  eqpId: string;
  chamberId: string | null;
  code: string;
  text: string;
  severity: Severity;
  state: AlarmState;
  /** Event-type alarms (FDC/QMS findings) have no clear: acknowledging closes them. */
  latching: boolean;
  raisedAt: number;
  lastAt: number;
  count: number;
  ackedAt: number | null;
  ackedBy: string | null;
  clearedAt: number | null;
  closedAt: number | null;
  escalation: number;
  shelved: boolean;
  context: Record<string, string | number>;
}

export interface NotificationRule {
  id: string;
  name: string;
  enabled: boolean;
  minSeverity: Severity;
  sources: AlarmSource[];
  /** Equipment id or prefix with *, e.g. "ETCH-*". */
  eqpPattern: string;
  group: string;
  channels: Channel[];
}

export interface Group {
  id: string;
  name: string;
  members: string[];
}

export interface AmsConfig {
  rules: NotificationRule[];
  groups: Group[];
  /** Escalate unacknowledged alarms of at least this severity. */
  escalationMinSeverity: Severity;
  /** Seconds unacknowledged before each escalation level, and who gets it. */
  escalation: Array<{ afterSec: number; group: string }>;
  floodThreshold: number;
  floodWindowSec: number;
}

export const DEFAULT_AMS_CONFIG: AmsConfig = {
  groups: [
    { id: "EQP-ENG", name: "Equipment Engineering on-call", members: ["ee.oncall-1", "ee.oncall-2"] },
    { id: "PROC-ENG", name: "Process Engineering on-call", members: ["pe.oncall-1"] },
    { id: "QUALITY", name: "Quality Engineering", members: ["qe.oncall-1", "qe.lead"] },
    { id: "SHIFT-LEAD", name: "Shift Leader", members: ["shift.lead"] },
    { id: "AREA-MGR", name: "Area Manager", members: ["area.manager"] },
  ],
  rules: [
    { id: "R1", name: "Equipment major+ → EE", enabled: true, minSeverity: "MAJOR", sources: ["EQP", "EES"], eqpPattern: "*", group: "EQP-ENG", channels: ["MESSENGER", "SMS"] },
    { id: "R2", name: "FDC faults → PE", enabled: true, minSeverity: "WARNING", sources: ["FDC"], eqpPattern: "*", group: "PROC-ENG", channels: ["MESSENGER"] },
    { id: "R3", name: "Quality → QE", enabled: true, minSeverity: "WARNING", sources: ["QMS"], eqpPattern: "*", group: "QUALITY", channels: ["MESSENGER", "EMAIL"] },
    { id: "R4", name: "Critical → Shift leader", enabled: true, minSeverity: "CRITICAL", sources: ["EQP", "FDC", "QMS", "EES", "AMS"], eqpPattern: "*", group: "SHIFT-LEAD", channels: ["SMS"] },
  ],
  escalationMinSeverity: "MAJOR",
  escalation: [
    { afterSec: 180, group: "SHIFT-LEAD" },
    { afterSec: 600, group: "AREA-MGR" },
  ],
  floodThreshold: 12,
  floodWindowSec: 600,
};

export interface Notification {
  id: number;
  ts: number;
  alarmId: number;
  eqpId: string;
  severity: Severity;
  reason: "NEW" | "ESCALATION" | "SEVERITY_UP";
  rule: string;
  group: string;
  recipients: string[];
  channels: Channel[];
  message: string;
}

interface Shelf {
  eqpId: string;
  code: string;
  until: number;
  by: string;
}

const MAX_ALARMS = 3000;
const MAX_NOTIFICATIONS = 2000;

export class AmsSystem implements FabSystem {
  readonly id = "AMS" as const;
  config: AmsConfig = structuredClone(DEFAULT_AMS_CONFIG);
  private alarms: AmsAlarm[] = [];
  private open = new Map<string, AmsAlarm>();
  private notifications: Notification[] = [];
  private shelves: Shelf[] = [];
  private seq = 0;
  private notifySeq = 0;
  private recentByEqp = new Map<string, number[]>();
  private floodUntil = new Map<string, number>();
  private now = 0;

  constructor(private bus: MessageBus) {
    bus.subscribe("AMS", "eqp/+/alarm", (m) => this.onEquipmentAlarm(m as Envelope<AlarmPayload>), "Equipment alarms");
    bus.subscribe("AMS", topics.fdcAlarm, (m) => this.onFdc(m as Envelope<FdcAlarmPayload>), "FDC faults");
    bus.subscribe("AMS", topics.qmsAlarm, (m) => this.onSystem("QMS", m as Envelope<SystemAlarmPayload>), "QMS alarms");
    bus.subscribe("AMS", topics.eesAlarm, (m) => this.onSystem("EES", m as Envelope<SystemAlarmPayload>), "EES alerts");
  }

  reset() {
    this.alarms = [];
    this.open.clear();
    this.notifications = [];
    this.recentByEqp.clear();
    this.floodUntil.clear();
  }

  // ------------------------------------------------------------ inputs

  private onEquipmentAlarm(m: Envelope<AlarmPayload>) {
    const a = m.payload;
    const key = `EQP|${a.eqpId}|${a.code}|${a.chamberId ?? ""}`;
    if (a.set) {
      this.raise({ key, source: "EQP", eqpId: a.eqpId, chamberId: a.chamberId, code: a.code, text: a.text, severity: a.severity, latching: false, context: { alid: a.alid, category: a.category } }, m.ts);
    } else {
      this.clear(key, m.ts);
    }
  }

  private onFdc(m: Envelope<FdcAlarmPayload>) {
    const f = m.payload;
    this.raise(
      {
        key: `FDC|${f.eqpId}|${f.faultClass}-${f.param}|${f.chamberId}`,
        source: "FDC",
        eqpId: f.eqpId,
        chamberId: f.chamberId,
        code: `FDC-${f.faultClass}-${f.param.toUpperCase()}`,
        text: f.message + (f.interlock ? " → equipment HOLD requested" : ""),
        severity: f.severity,
        latching: true,
        context: { runId: f.runId, lotId: f.lotId, recipeId: f.recipeId, step: f.stepNo, value: f.value },
      },
      m.ts,
    );
  }

  private onSystem(source: "QMS" | "EES", m: Envelope<SystemAlarmPayload>) {
    const a = m.payload;
    const key = `${source}|${a.eqpId}|${a.code}|`;
    const latching = source === "QMS";
    if (a.set) this.raise({ key, source, eqpId: a.eqpId, chamberId: null, code: a.code, text: a.text, severity: a.severity, latching, context: a.context ?? {} }, m.ts);
    else this.clear(key, m.ts);
  }

  // --------------------------------------------------------- lifecycle

  private raise(
    a: Pick<AmsAlarm, "key" | "source" | "eqpId" | "chamberId" | "code" | "text" | "severity" | "latching" | "context">,
    ts: number,
  ) {
    this.now = Math.max(this.now, ts);
    const existing = this.open.get(a.key);
    if (existing) {
      existing.count++;
      existing.lastAt = ts;
      existing.text = a.text;
      existing.context = a.context;
      if (existing.state === "CLEARED") {
        existing.state = existing.ackedAt ? "ACKED" : "ACTIVE";
        existing.clearedAt = null;
      }
      if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[existing.severity]) {
        existing.severity = a.severity;
        this.notify(existing, "SEVERITY_UP", ts);
      }
      this.publish(existing, ts);
      return;
    }
    const shelved = this.shelves.some((s) => s.until > ts && s.code === a.code && (s.eqpId === "*" || s.eqpId === a.eqpId));
    const alarm: AmsAlarm = {
      ...a,
      id: ++this.seq,
      state: "ACTIVE",
      raisedAt: ts,
      lastAt: ts,
      count: 1,
      ackedAt: null,
      ackedBy: null,
      clearedAt: null,
      closedAt: null,
      escalation: 0,
      shelved,
    };
    pushRing(this.alarms, alarm, MAX_ALARMS);
    this.open.set(a.key, alarm);
    this.publish(alarm, ts);
    if (!shelved) this.notify(alarm, "NEW", ts);
    if (a.source !== "AMS") this.floodCheck(a.eqpId, ts);
  }

  private clear(key: string, ts: number) {
    const alarm = this.open.get(key);
    if (!alarm || alarm.state === "CLEARED") return;
    alarm.clearedAt = ts;
    if (alarm.state === "ACKED") this.close(alarm, ts);
    else alarm.state = "CLEARED";
    this.publish(alarm, ts);
  }

  private close(alarm: AmsAlarm, ts: number) {
    alarm.state = "CLOSED";
    alarm.closedAt = ts;
    this.open.delete(alarm.key);
  }

  ack(id: number, by: string, ts: number): AmsAlarm {
    const alarm = this.alarms.find((a) => a.id === id);
    if (!alarm) throw new Error(`Unknown alarm ${id}`);
    if (alarm.state === "CLOSED" || alarm.state === "ACKED") return alarm;
    alarm.ackedAt = ts;
    alarm.ackedBy = by;
    if (alarm.state === "CLEARED" || alarm.latching) this.close(alarm, ts);
    else alarm.state = "ACKED";
    this.publish(alarm, ts);
    return alarm;
  }

  ackAll(filter: { eqpId?: string; source?: string }, by: string, ts: number): number {
    let n = 0;
    for (const a of [...this.open.values()]) {
      if ((a.state === "ACTIVE" || a.state === "CLEARED") && matchesFilter(a.eqpId, filter.eqpId) && matchesFilter(a.source, filter.source)) {
        this.ack(a.id, by, ts);
        n++;
      }
    }
    return n;
  }

  /** Force-close (e.g. a stale alarm whose clear never came). */
  closeAlarm(id: number, by: string, ts: number): AmsAlarm {
    const alarm = this.alarms.find((a) => a.id === id);
    if (!alarm) throw new Error(`Unknown alarm ${id}`);
    if (alarm.state !== "CLOSED") {
      if (!alarm.ackedAt) {
        alarm.ackedAt = ts;
        alarm.ackedBy = by;
      }
      this.close(alarm, ts);
      this.publish(alarm, ts);
    }
    return alarm;
  }

  shelve(eqpId: string, code: string, minutes: number, by: string, ts: number) {
    this.shelves = this.shelves.filter((s) => s.until > ts && !(s.eqpId === eqpId && s.code === code));
    const shelf = { eqpId, code, until: ts + minutes * 60_000, by };
    if (minutes > 0) this.shelves.push(shelf);
    for (const a of this.open.values()) if (a.code === code && (eqpId === "*" || a.eqpId === eqpId)) a.shelved = minutes > 0;
    return shelf;
  }

  private publish(alarm: AmsAlarm, ts: number) {
    this.bus.publish(
      topics.amsAlarm,
      "ams.alarm",
      "AMS",
      { id: alarm.id, source: alarm.source, eqpId: alarm.eqpId, code: alarm.code, severity: alarm.severity, state: alarm.state, count: alarm.count },
      ts,
    );
  }

  // -------------------------------------------------------- notification

  private matchEqp(pattern: string, eqpId: string) {
    if (pattern === "*" || pattern === eqpId) return true;
    return pattern.endsWith("*") && eqpId.startsWith(pattern.slice(0, -1));
  }

  private notify(alarm: AmsAlarm, reason: "NEW" | "SEVERITY_UP", ts: number) {
    for (const rule of this.config.rules) {
      if (!rule.enabled || !rule.sources.includes(alarm.source)) continue;
      if (SEVERITY_RANK[alarm.severity] < SEVERITY_RANK[rule.minSeverity]) continue;
      if (!this.matchEqp(rule.eqpPattern, alarm.eqpId)) continue;
      this.send(alarm, reason, rule.name, rule.group, rule.channels, ts);
    }
  }

  private send(alarm: AmsAlarm, reason: Notification["reason"], rule: string, groupId: string, channels: Channel[], ts: number) {
    const group = this.config.groups.find((g) => g.id === groupId);
    const n: Notification = {
      id: ++this.notifySeq,
      ts,
      alarmId: alarm.id,
      eqpId: alarm.eqpId,
      severity: alarm.severity,
      reason,
      rule,
      group: groupId,
      recipients: group?.members ?? [],
      channels,
      message: `[${alarm.severity}] ${alarm.eqpId}${alarm.chamberId ? "/" + alarm.chamberId : ""} ${alarm.code}: ${alarm.text}`,
    };
    pushRing(this.notifications, n, MAX_NOTIFICATIONS);
    this.bus.publish(topics.amsNotify, "ams.notify", "AMS", n, ts);
  }

  private floodCheck(eqpId: string, ts: number) {
    const win = this.config.floodWindowSec * 1000;
    const list = (this.recentByEqp.get(eqpId) ?? []).filter((t) => ts - t < win);
    list.push(ts);
    this.recentByEqp.set(eqpId, list);
    if (list.length >= this.config.floodThreshold && (this.floodUntil.get(eqpId) ?? 0) < ts) {
      this.floodUntil.set(eqpId, ts + win);
      this.raise(
        {
          key: `AMS|${eqpId}|ALARM-FLOOD|`,
          source: "AMS",
          eqpId,
          chamberId: null,
          code: "AMS-ALARM-FLOOD",
          text: `Alarm flood: ${list.length} alarms in ${this.config.floodWindowSec}s`,
          severity: "CRITICAL",
          latching: true,
          context: { count: list.length },
        },
        ts,
      );
    }
  }

  tick(now: number) {
    this.now = now;
    for (const a of this.open.values()) {
      if (a.state !== "ACTIVE" || a.shelved) continue;
      if (SEVERITY_RANK[a.severity] < SEVERITY_RANK[this.config.escalationMinSeverity]) continue;
      const level = this.config.escalation[a.escalation];
      if (!level || now - a.raisedAt < level.afterSec * 1000) continue;
      a.escalation++;
      this.send(a, "ESCALATION", `Escalation L${a.escalation}`, level.group, ["SMS", "MESSENGER"], now);
      this.publish(a, now);
    }
  }

  // ------------------------------------------------------------- API

  listAlarms(filter: { state?: string; source?: string; eqpId?: string; openOnly?: boolean; limit?: number }) {
    const out: AmsAlarm[] = [];
    for (let i = this.alarms.length - 1; i >= 0 && out.length < (filter.limit ?? 300); i--) {
      const a = this.alarms[i];
      if (filter.openOnly && a.state === "CLOSED") continue;
      if (!matchesFilter(a.state, filter.state) || !matchesFilter(a.source, filter.source) || !matchesFilter(a.eqpId, filter.eqpId)) continue;
      out.push(a);
    }
    return out;
  }

  listNotifications(limit = 200) {
    return this.notifications.slice(-limit).reverse();
  }

  listShelves(now = this.now) {
    return this.shelves.filter((s) => s.until > now);
  }

  stats() {
    const bySource: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byEqp: Record<string, number> = {};
    const byCode: Record<string, { code: string; source: string; count: number }> = {};
    let ackTime = 0;
    let acked = 0;
    for (const a of this.alarms) {
      bySource[a.source] = (bySource[a.source] ?? 0) + 1;
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      byEqp[a.eqpId] = (byEqp[a.eqpId] ?? 0) + 1;
      const c = (byCode[a.code] ??= { code: a.code, source: a.source, count: 0 });
      c.count += a.count;
      if (a.ackedAt) {
        ackTime += a.ackedAt - a.raisedAt;
        acked++;
      }
    }
    const open = [...this.open.values()];
    return {
      total: this.alarms.length,
      active: open.filter((a) => a.state === "ACTIVE").length,
      acked: open.filter((a) => a.state === "ACKED").length,
      clearedUnacked: open.filter((a) => a.state === "CLEARED").length,
      criticalOpen: open.filter((a) => a.severity === "CRITICAL" && a.state !== "CLOSED").length,
      notifications: this.notifications.length,
      mttaSec: acked ? round(ackTime / acked / 1000, 1) : null,
      bySource,
      bySeverity,
      byEqp,
      topCodes: Object.values(byCode).sort((a, b) => b.count - a.count).slice(0, 10),
    };
  }

  setConfig(patch: Partial<AmsConfig>) {
    this.config = { ...this.config, ...patch };
    return this.config;
  }
}
