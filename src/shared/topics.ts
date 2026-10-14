// Bus topic layout. MQTT-style: "+" matches one level, "#" the rest.

export const topics = {
  info: (eqpId: string) => `eqp/${eqpId}/info`,
  trace: (eqpId: string, chamberId: string) => `eqp/${eqpId}/trace/${chamberId}`,
  event: (eqpId: string) => `eqp/${eqpId}/event`,
  alarm: (eqpId: string) => `eqp/${eqpId}/alarm`,
  state: (eqpId: string) => `eqp/${eqpId}/state`,
  link: (eqpId: string) => `eqp/${eqpId}/link`,
  metrology: (eqpId: string) => `eqp/${eqpId}/metrology`,
  command: (eqpId: string) => `eqp/${eqpId}/cmd`,
  fdcAlarm: "fdc/alarm",
  fdcRun: "fdc/run",
  qmsAlarm: "qms/alarm",
  qmsLot: "qms/lot",
  eesAlarm: "ees/alarm",
  amsAlarm: "ams/alarm",
  amsNotify: "ams/notify",
} as const;

export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "#" || pattern === topic) return true;
  const p = pattern.split("/");
  const t = topic.split("/");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "#") return true;
    if (i >= t.length) return false;
    if (p[i] !== "+" && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}
