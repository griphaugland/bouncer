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

import { DEFAULT_POLICY, renderPolicy } from "../src/policy";

describe("renderPolicy", () => {
  test("round-trips: what it writes parses back to the same policy", () => {
    const custom = parsePolicy({
      maxConcurrent: 4,
      slots: { dotnet: 2, node: 3, e2e: 1 },
      tools: { bazel: { slot: "jvm", heavy: ["build", "test"] }, docker: false },
      notifications: false,
    });
    const reparsed = parsePolicy(Bun.YAML.parse(renderPolicy(custom, ["Tuned for: test Mac"])));
    expect(reparsed).toEqual(custom);
  });

  test("defaults round-trip too", () => {
    expect(parsePolicy(Bun.YAML.parse(renderPolicy(DEFAULT_POLICY)))).toEqual(DEFAULT_POLICY);
  });
});
