import { describe, expect, test } from "bun:test";
import { parsePolicy } from "../src/policy";

describe("policy tools", () => {
  test("merges custom tools over defaults and lets one be disabled", () => {
    const p = parsePolicy({ tools: { bazel: { slot: "jvm", heavy: ["build"] }, docker: false } });
    expect(p.tools.bazel).toEqual({ slot: "jvm", heavy: ["build"] });
    expect(p.tools.cargo?.slot).toBe("rust");
    expect(p.tools.docker).toBeUndefined();
  });

  test("rejects malformed tools instead of silently ignoring them", () => {
    expect(() => parsePolicy({ tools: { bazel: { slot: "jvm" } } })).toThrow(/heavy/);
    expect(() => parsePolicy({ tools: { "rm -rf": { slot: "x", heavy: [] } } })).toThrow(/not a valid command name/);
  });
});
