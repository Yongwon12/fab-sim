import { describe, expect, it } from "vitest";
import { MessageBus } from "./message-bus";
import { topicMatches } from "../../shared/topics";

describe("topicMatches", () => {
  it("handles + and # wildcards", () => {
    expect(topicMatches("eqp/+/trace/+", "eqp/ETCH-01/trace/PM1")).toBe(true);
    expect(topicMatches("eqp/+/trace/+", "eqp/ETCH-01/event")).toBe(false);
    expect(topicMatches("eqp/#", "eqp/ETCH-01/trace/PM1")).toBe(true);
    expect(topicMatches("eqp/+/event", "eqp/ETCH-01/event/extra")).toBe(false);
    expect(topicMatches("fdc/alarm", "fdc/alarm")).toBe(true);
    expect(topicMatches("#", "anything/at/all")).toBe(true);
  });
});

describe("MessageBus", () => {
  it("delivers in FIFO order, also for messages published from a handler", () => {
    const bus = new MessageBus();
    const order: string[] = [];
    bus.subscribe("A", "a", () => {
      order.push("a");
      bus.publish("b", "event", "test", {}, 0);
      order.push("a-done");
    });
    bus.subscribe("B", "b", () => order.push("b"));
    bus.publish("a", "event", "test", {}, 0);
    expect(order).toEqual(["a", "a-done", "b"]);
  });

  it("skips disabled routes and counts deliveries", () => {
    const bus = new MessageBus();
    let got = 0;
    bus.subscribe("FDC", "eqp/+/trace/+", () => got++);
    bus.publish("eqp/X/trace/PM1", "trace", "X", {}, 0);
    expect(bus.setRouteEnabled("FDC", "eqp/+/trace/+", false)).toBe(true);
    bus.publish("eqp/X/trace/PM1", "trace", "X", {}, 0);
    expect(got).toBe(1);
    expect(bus.routes()[0]).toMatchObject({ subscriber: "FDC", enabled: false, delivered: 1 });
  });

  it("isolates a failing subscriber", () => {
    const bus = new MessageBus();
    let ok = 0;
    const original = console.error;
    console.error = () => undefined;
    bus.subscribe("BAD", "#", () => {
      throw new Error("boom");
    });
    bus.subscribe("GOOD", "#", () => ok++);
    bus.publish("x", "event", "t", {}, 0);
    console.error = original;
    expect(ok).toBe(1);
    expect(bus.routes().find((r) => r.subscriber === "BAD")!.errors).toBe(1);
  });
});
