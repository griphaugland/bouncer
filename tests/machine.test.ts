import { describe, expect, test } from "bun:test";
import { macosMajor, recommend } from "../src/machine";

describe("recommend", () => {
  test.each([
    // [memoryGb, performanceCores, sessions] -> [maxConcurrent, dotnet, node]
    [8, 4, 3, 1, 1, 1], // MacBook Air M1
    [16, 4, 4, 2, 1, 2], // M2 base
    [18, 6, 6, 2, 1, 2], // M3 Pro
    [36, 10, 6, 4, 2, 3], // M3 Max
    [64, 12, 6, 6, 2, 4], // Mac Studio
    [128, 16, 6, 6, 2, 4],
  ])("%d GB, %d P-cores, %d sessions -> max %d, dotnet %d, node %d", (gb, pc, sessions, max, dotnet, node) => {
    const t = recommend({ memoryGb: gb, performanceCores: pc }, sessions);
    expect([t.maxConcurrent, t.slots.dotnet, t.slots.node]).toEqual([max, dotnet, node]);
  });

  test("many agent sessions come out of the build budget", () => {
    const few = recommend({ memoryGb: 24, performanceCores: 8 }, 4);
    const many = recommend({ memoryGb: 24, performanceCores: 8 }, 20);
    expect(few.maxConcurrent).toBe(3);
    expect(many.maxConcurrent).toBe(2);
    expect(many.reasons[0]).toContain("20 agent sessions");
  });

  test("performance cores cap parallel builds", () => {
    const t = recommend({ memoryGb: 64, performanceCores: 4 });
    expect(t.maxConcurrent).toBe(2);
    expect(t.reasons.join(" ")).toContain("4 performance cores");
  });

  test("slot sizes never exceed the global cap", () => {
    for (const gb of [4, 8, 16, 24, 36, 64, 192]) {
      for (const pc of [2, 4, 8, 16]) {
        const t = recommend({ memoryGb: gb, performanceCores: pc });
        for (const cap of Object.values(t.slots)) expect(cap).toBeLessThanOrEqual(Math.max(1, t.maxConcurrent));
        expect(t.gate.redFreePercent).toBeLessThan(t.gate.yellowFreePercent);
      }
    }
  });

  test("the measured session cost keeps a busy 18 GB Mac at two builds", () => {
    // 26 sessions was the real load on the machine this was tuned on.
    expect(recommend({ memoryGb: 18, performanceCores: 6 }, 26).maxConcurrent).toBe(2);
  });

  test("small Macs get earlier warnings", () => {
    expect(recommend({ memoryGb: 8, performanceCores: 4 }).gate.yellowFreePercent).toBe(30);
  });
});

test("macosMajor", () => {
  expect(macosMajor("26.7.1")).toBe(26);
  expect(macosMajor("13.0")).toBe(13);
  expect(macosMajor("")).toBe(0);
});
