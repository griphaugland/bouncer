import { describe, expect, test } from "bun:test";
import { classifyCommandString, classifyInvocation } from "../src/classify";

describe("classifyInvocation", () => {
  test.each([
    ["dotnet", ["test"], "dotnet"],
    ["dotnet", ["build", "-c", "Release"], "dotnet"],
    ["dotnet", ["run", "--project", "src/Api"], "dotnet"],
    ["dotnet", ["bin/Api.dll"], "dotnet"],
    ["dotnet", ["--version"], null],
    ["dotnet", ["--list-sdks"], null],
    ["dotnet", ["new", "console"], null],
    ["pnpm", ["test"], "node"],
    ["pnpm", ["install"], "node"],
    ["pnpm", ["--filter", "web", "build"], "node"],
    ["pnpm", ["-C", "frontend", "run", "typecheck"], "node"],
    ["pnpm", ["run", "test:unit"], "node"],
    ["pnpm", ["exec", "tsc", "--noEmit"], "node"],
    ["pnpm", ["dev"], null],
    ["pnpm", ["run", "dev"], null],
    ["pnpm", ["vitest", "--watch"], null],
    ["pnpm", ["--version"], null],
    ["npm", ["run", "build"], "node"],
    ["npm", ["ci"], "node"],
    ["npm", ["start"], null],
    ["npx", ["vitest", "run"], "node"],
    ["npx", ["next", "build"], "node"],
    ["npx", ["next", "dev"], null],
    ["npx", ["prettier", "--write", "."], null],
    ["yarn", [], "node"],
    ["xcodebuild", ["-scheme", "App", "build"], "xcode"],
    ["xcodebuild", ["-list"], null],
  ] as const)("%s %j -> %s", (tool, args, slot) => {
    expect(classifyInvocation(tool, [...args])).toBe(slot);
  });
});

describe("classifyCommandString", () => {
  test("finds heavy invocations across chained commands", () => {
    expect(classifyCommandString("cd src && dotnet test --filter Foo")).toEqual(["dotnet"]);
    expect(classifyCommandString("pnpm install && pnpm build; dotnet build")).toEqual(["node", "dotnet"]);
  });

  test("skips env assignments and wrappers", () => {
    expect(classifyCommandString("LANG=en_US.UTF-8 npx vitest run")).toEqual(["node"]);
    expect(classifyCommandString("time /opt/homebrew/bin/dotnet test")).toEqual(["dotnet"]);
  });

  test("ignores light commands and explicit bypass", () => {
    expect(classifyCommandString("git status && ls -la")).toEqual([]);
    expect(classifyCommandString("BOUNCER_BYPASS=1 dotnet test")).toEqual([]);
    expect(classifyCommandString("dotnet --info | head")).toEqual([]);
  });
});
