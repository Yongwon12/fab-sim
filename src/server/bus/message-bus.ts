import type { Envelope, MessageKind } from "../../shared/types";
import { topicMatches } from "../../shared/topics";

export type Handler = (msg: Envelope) => void;

interface Subscription {
  subscriber: string;
  pattern: string;
  label: string;
  handler: Handler;
  enabled: boolean;
  delivered: number;
  errors: number;
}

export interface RouteInfo {
  subscriber: string;
  pattern: string;
  label: string;
  enabled: boolean;
  delivered: number;
  errors: number;
}

export interface BusStats {
  published: number;
  byKind: Partial<Record<MessageKind, number>>;
  byTopicRoot: Record<string, number>;
}

/**
 * In-process publish/subscribe bus between the equipment (via the unified
 * adapter) and the fab systems. Systems never call each other directly; they
 * only see topics, so any of them could move behind a real broker
 * (MQTT/Kafka) by swapping this class.
 *
 * Delivery is synchronous and FIFO: a message published from inside a handler
 * is queued and delivered after the current one, so ordering stays stable and
 * stacks stay shallow.
 */
export class MessageBus {
  private subs: Subscription[] = [];
  private seq = 0;
  private queue: Envelope[] = [];
  private draining = false;
  private recentRing: Envelope[] = [];
  private readonly recentSize: number;
  private taps: Handler[] = [];
  private stats: BusStats = { published: 0, byKind: {}, byTopicRoot: {} };

  constructor(recentSize = 400) {
    this.recentSize = recentSize;
  }

  subscribe(subscriber: string, pattern: string, handler: Handler, label = ""): () => void {
    const sub: Subscription = {
      subscriber,
      pattern,
      label,
      handler,
      enabled: true,
      delivered: 0,
      errors: 0,
    };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  /** Observe every message regardless of routing (UI gateway, bus monitor). */
  tap(handler: Handler): () => void {
    this.taps.push(handler);
    return () => {
      this.taps = this.taps.filter((h) => h !== handler);
    };
  }

  publish<T>(topic: string, kind: MessageKind, source: string, payload: T, ts: number): Envelope<T> {
    const msg: Envelope<T> = { id: ++this.seq, topic, kind, ts, source, payload };
    this.stats.published++;
    this.stats.byKind[kind] = (this.stats.byKind[kind] ?? 0) + 1;
    const root = topic.split("/")[0];
    this.stats.byTopicRoot[root] = (this.stats.byTopicRoot[root] ?? 0) + 1;
    if (kind !== "trace") {
      this.recentRing.push(msg);
      if (this.recentRing.length > this.recentSize) this.recentRing.shift();
    }
    this.queue.push(msg);
    if (!this.draining) this.drain();
    return msg;
  }

  private drain() {
    this.draining = true;
    try {
      while (this.queue.length) {
        const msg = this.queue.shift()!;
        for (const tap of this.taps) {
          try {
            tap(msg);
          } catch (err) {
            console.error("[bus] tap failed", err);
          }
        }
        for (const sub of this.subs) {
          if (!sub.enabled || !topicMatches(sub.pattern, msg.topic)) continue;
          try {
            sub.handler(msg);
            sub.delivered++;
          } catch (err) {
            sub.errors++;
            console.error(`[bus] ${sub.subscriber} failed on ${msg.topic}`, err);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  routes(): RouteInfo[] {
    return this.subs.map(({ subscriber, pattern, label, enabled, delivered, errors }) => ({
      subscriber,
      pattern,
      label,
      enabled,
      delivered,
      errors,
    }));
  }

  setRouteEnabled(subscriber: string, pattern: string, enabled: boolean): boolean {
    let found = false;
    for (const sub of this.subs) {
      if (sub.subscriber === subscriber && sub.pattern === pattern) {
        sub.enabled = enabled;
        found = true;
      }
    }
    return found;
  }

  getStats(): BusStats {
    return {
      published: this.stats.published,
      byKind: { ...this.stats.byKind },
      byTopicRoot: { ...this.stats.byTopicRoot },
    };
  }

  recent(limit = 200): Envelope[] {
    return this.recentRing.slice(-limit);
  }

  resetStats() {
    this.stats = { published: 0, byKind: {}, byTopicRoot: {} };
    this.recentRing = [];
    for (const sub of this.subs) {
      sub.delivered = 0;
      sub.errors = 0;
    }
  }
}
