import { useEffect, useRef, useState } from "react";
import type { Envelope, EventPayload, RunContext, TracePayload } from "../../../shared/types";
import { api } from "../../api";
import { useTopics } from "../../store";

export interface TracePoint {
  ts: number;
  values: Record<string, number>;
  setpoints: Record<string, number>;
  ctx: RunContext | null;
}

const MAX_POINTS = 1800;
const MAX_EVENTS = 400;

/** Live buffers for the equipment the console is showing. */
export class EquipmentFeed {
  traces = new Map<string, TracePoint[]>();
  events: Envelope<EventPayload>[] = [];
  dirty = false;

  push(msgs: Envelope[]) {
    for (const m of msgs) {
      if (m.kind === "trace") {
        const t = m.payload as TracePayload;
        const list = this.traces.get(t.chamberId) ?? [];
        list.push({ ts: m.ts, values: t.values, setpoints: t.setpoints, ctx: t.context });
        if (list.length > MAX_POINTS) list.splice(0, list.length - MAX_POINTS);
        this.traces.set(t.chamberId, list);
      } else if (m.kind === "event") {
        this.events.push(m as Envelope<EventPayload>);
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      }
    }
    this.dirty = true;
  }
}

export function useEquipmentFeed(eqpId: string) {
  const ref = useRef<{ id: string; feed: EquipmentFeed } | null>(null);
  if (!ref.current || ref.current.id !== eqpId) ref.current = { id: eqpId, feed: new EquipmentFeed() };
  const feed = ref.current.feed;
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .get<Envelope<EventPayload>[]>(`/api/equipment/${encodeURIComponent(eqpId)}/events?limit=200`)
      .then((evs) => {
        if (!alive) return;
        const known = new Set(feed.events.map((e) => e.id));
        feed.events = [...evs.reverse().filter((e) => !known.has(e.id)), ...feed.events];
        feed.dirty = true;
      })
      .catch(() => undefined);
    const timer = setInterval(() => {
      if (feed.dirty) {
        feed.dirty = false;
        setVersion((v) => v + 1);
      }
    }, 400);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [eqpId, feed]);

  useTopics([`eqp/${eqpId}/trace/+`, `eqp/${eqpId}/event`], (msgs) => feed.push(msgs));
  return { feed, version };
}
