import { describe, expect, test } from "bun:test";
import { isDue, nextClockTime, parseDelay, pickEnv } from "../src/schedule";

describe("nextClockTime", () => {
  const now = new Date(2026, 10, 2, 22, 30); // 2026-11-02 22:30 local

  test("later today", () => {
    expect(new Date(nextClockTime("23:15", now)).getHours()).toBe(23);
    expect(new Date(nextClockTime("23:15", now)).getDate()).toBe(2);
  });

  test("already passed today means tomorrow", () => {
    const t = new Date(nextClockTime("02:00", now));
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([3, 2, 0]);
  });

  test("exactly now means tomorrow, not immediately", () => {
    expect(new Date(nextClockTime("22:30", now)).getDate()).toBe(3);
  });

  test("rejects nonsense", () => {
    expect(() => nextClockTime("25:00", now)).toThrow();
    expect(() => nextClockTime("2am", now)).toThrow();
  });
});

describe("parseDelay", () => {
  test.each([
    ["30m", 1_800_000],
    ["2h", 7_200_000],
    ["90s", 90_000],
    ["1h30m", 5_400_000],
  ])("%s", (text, ms) => expect(parseDelay(text)).toBe(ms));

  test("rejects junk", () => {
    expect(() => parseDelay("soon")).toThrow();
    expect(() => parseDelay("30x")).toThrow();
    expect(() => parseDelay("30m please")).toThrow();
  });
});

describe("isDue", () => {
  test("time and idleness both have to hold", () => {
    expect(isDue({ at: 100, whenIdle: false }, { now: 50, idle: true })).toBe(false);
    expect(isDue({ at: 100, whenIdle: false }, { now: 100, idle: false })).toBe(true);
    expect(isDue({ at: 100, whenIdle: true }, { now: 200, idle: false })).toBe(false);
    expect(isDue({ at: null, whenIdle: true }, { now: 0, idle: true })).toBe(true);
  });
});

test("pickEnv never keeps secrets", () => {
  const env = pickEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "sk-x" });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
});
