import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, type Policy } from "../src/policy";
import { Scheduler } from "../src/scheduler";

const policy: Policy = { ...DEFAULT_POLICY, maxConcurrent: 3, slots: { dotnet: 1, node: 2 } };
const job = (slot: string, session = "s1", cmd = `${slot} build`) => ({ slot, session, cwd: "/tmp", cmd });

function runIds(actions: ReturnType<Scheduler["tick"]>): number[] {
  return actions.filter((a) => a.type === "run").map((a) => a.job.id);
}

describe("admission", () => {
  test("respects slot capacity and queues the rest in order", () => {
    const s = new Scheduler(policy);
    const a = s.enqueue(job("dotnet"), 0);
    const b = s.enqueue(job("dotnet"), 1);
    expect(runIds(s.tick(2))).toEqual([a.id]);
    expect(b.state).toBe("queued");
    expect(b.waitReason).toContain("dotnet slot full");
    s.finish(a.id, 3, 0);
    expect(runIds(s.tick(4))).toEqual([b.id]);
  });

  test("a full dotnet slot does not block node jobs", () => {
    const s = new Scheduler(policy);
    s.enqueue(job("dotnet"), 0);
    s.enqueue(job("dotnet"), 0);
    const n = s.enqueue(job("node"), 0);
    expect(runIds(s.tick(1))).toContain(n.id);
  });

  test("maxConcurrent caps jobs across slots", () => {
    const s = new Scheduler({ ...policy, maxConcurrent: 2 });
    s.enqueue(job("dotnet"), 0);
    s.enqueue(job("node"), 0);
    const third = s.enqueue(job("node"), 0);
    expect(runIds(s.tick(1))).toHaveLength(2);
    expect(third.waitReason).toContain("max 2");
  });

  test("yellow load admits one heavy job at a time", () => {
    const s = new Scheduler(policy);
    s.load = "yellow";
    s.enqueue(job("node"), 0);
    const second = s.enqueue(job("node"), 0);
    expect(runIds(s.tick(1))).toHaveLength(1);
    expect(second.waitReason).toContain("one heavy job at a time");
  });

  test("red load admits nothing", () => {
    const s = new Scheduler(policy);
    s.load = "red";
    s.enqueue(job("node"), 0);
    expect(runIds(s.tick(1))).toEqual([]);
  });
});

describe("priority", () => {
  test("a prioritized session jumps the queue", () => {
    const s = new Scheduler(policy);
    const running = s.enqueue(job("dotnet", "a"), 0);
    s.tick(0);
    const normal = s.enqueue(job("dotnet", "a"), 1);
    s.prioritizeSession("b", 2);
    const high = s.enqueue(job("dotnet", "b"), 3);
    expect(high.priority).toBe("high");
    expect(s.queued().map((j) => j.id)).toEqual([high.id, normal.id]);
    expect(running.state).toBe("running");
  });

  test("high priority preempts the newest normal job in a full slot, which requeues at the front", () => {
    const s = new Scheduler(policy);
    const victim = s.enqueue(job("dotnet", "a"), 0);
    s.tick(0);
    const waiting = s.enqueue(job("dotnet", "a"), 1);
    s.prioritizeSession("b", 2);
    const high = s.enqueue(job("dotnet", "b"), 3);

    const actions = s.tick(4);
    expect(actions).toEqual([expect.objectContaining({ type: "preempt", job: victim, by: high })]);

    // A second tick must not kill anything else while the first stop is in flight.
    expect(s.tick(5).filter((a) => a.type === "preempt")).toEqual([]);

    s.requeue(victim.id);
    expect(runIds(s.tick(6))).toEqual([high.id]);
    // Preempted job goes ahead of the one that was already waiting.
    expect(s.queued().map((j) => j.id)).toEqual([victim.id, waiting.id]);
    expect(victim.preemptCount).toBe(1);
  });

  test("high priority never preempts another high-priority job", () => {
    const s = new Scheduler(policy);
    s.prioritizeSession("a", 0);
    s.prioritizeSession("b", 0);
    s.enqueue(job("dotnet", "a"), 0);
    s.tick(0);
    s.enqueue(job("dotnet", "b"), 1);
    expect(s.tick(2).filter((a) => a.type === "preempt")).toEqual([]);
  });

  test("high priority ignores the yellow one-at-a-time rule", () => {
    const s = new Scheduler(policy);
    s.enqueue(job("node", "a"), 0);
    s.tick(0);
    s.load = "yellow";
    s.prioritizeSession("b", 1);
    const high = s.enqueue(job("node", "b"), 1);
    expect(runIds(s.tick(2))).toEqual([high.id]);
  });

  test("priority expires", () => {
    const s = new Scheduler({ ...policy, priority: { minutes: 1 } });
    s.prioritizeSession("a", 0);
    expect(s.enqueue(job("node", "a"), 30_000).priority).toBe("high");
    expect(s.enqueue(job("node", "a"), 61_000).priority).toBe("normal");
  });
});

describe("reaper", () => {
  test("red load reaps the newest normal job, then waits for the cooldown", () => {
    const s = new Scheduler({ ...policy, reaper: { ...policy.reaper, cooldownSeconds: 30 } });
    const older = s.enqueue(job("node"), 0);
    s.tick(0);
    const newer = s.enqueue(job("node"), 1000);
    s.tick(1000);
    s.load = "red";
    expect(s.tick(2000)).toEqual([expect.objectContaining({ type: "reap", job: newer })]);
    s.finish(newer.id, 2500);
    expect(s.tick(3000)).toEqual([]);
    expect(s.tick(32_000)).toEqual([expect.objectContaining({ type: "reap", job: older })]);
  });

  test("a reaped job ends as reaped, not done, and is not retried", () => {
    const s = new Scheduler(policy);
    const j = s.enqueue(job("node"), 0);
    s.tick(0);
    s.load = "red";
    s.tick(1);
    expect(s.finish(j.id, 2, 137)?.state).toBe("reaped");
    expect(s.queued()).toEqual([]);
  });
});

describe("builds outside Bouncer", () => {
  test("take slot capacity and are named in the wait reason", () => {
    const s = new Scheduler(policy);
    s.external.set("dotnet", 1);
    const j = s.enqueue(job("dotnet"), 0);
    expect(runIds(s.tick(1))).toEqual([]);
    expect(j.waitReason).toBe("dotnet slot full (1/1, 1 outside Bouncer)");
    s.external.clear();
    expect(runIds(s.tick(2))).toEqual([j.id]);
  });

  test("count toward maxConcurrent", () => {
    const s = new Scheduler({ ...policy, maxConcurrent: 2 });
    s.external.set("node", 2);
    s.enqueue(job("dotnet"), 0);
    expect(runIds(s.tick(1))).toEqual([]);
  });

  test("are never preempted: a high job waits when only outside builds fill the slot", () => {
    const s = new Scheduler(policy);
    s.external.set("dotnet", 1);
    s.prioritizeSession("b", 0);
    s.enqueue(job("dotnet", "b"), 0);
    expect(s.tick(1)).toEqual([]);
  });
});

describe("probe", () => {
  test("reports whether a new job would start now", () => {
    const s = new Scheduler(policy);
    expect(s.wouldRunNow("dotnet", "a", 0).wouldRun).toBe(true);
    s.enqueue(job("dotnet"), 0);
    s.tick(0);
    expect(s.wouldRunNow("dotnet", "a", 1)).toEqual({ wouldRun: false, reason: "dotnet slot full (1/1)" });
    expect(s.wouldRunNow("node", "a", 1).wouldRun).toBe(true);
  });
});

describe("priority by project folder", () => {
  test("prioritizing a folder raises jobs started anywhere inside it, from any session", () => {
    const s = new Scheduler(policy);
    s.prioritizeCwd("/code/orbit", 0);
    const inside = s.enqueue({ slot: "node", session: "codex-pane", cwd: "/code/orbit/web", cmd: "pnpm build" }, 1);
    const exact = s.enqueue({ slot: "node", session: "x", cwd: "/code/orbit", cmd: "pnpm test" }, 1);
    const sibling = s.enqueue({ slot: "node", session: "y", cwd: "/code/orbit-billing", cmd: "pnpm test" }, 1);
    expect([inside.priority, exact.priority, sibling.priority]).toEqual(["high", "high", "normal"]);
  });

  test("expiry drops folder priority from jobs already queued", () => {
    const s = new Scheduler({ ...policy, priority: { minutes: 1 } });
    s.prioritizeCwd("/code/orbit", 0);
    const j = s.enqueue({ slot: "node", session: "a", cwd: "/code/orbit", cmd: "pnpm test" }, 1);
    expect(j.priority).toBe("high");
    s.isPrioritized("other", 61_000);
    expect(j.priority).toBe("normal");
  });
});
