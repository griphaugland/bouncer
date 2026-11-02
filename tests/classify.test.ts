import { describe, expect, test } from "bun:test";
import { classifyCommandString, classifyInvocation } from "../src/classify";

describe("classifyInvocation", () => {
  test.each([
    ["dotnet", ["test"], "dotnet"],
    ["dotnet", ["build", "-c", "Release"], "dotnet"],
    // Servers run until stopped; they must never hold a slot (review finding #2).
    ["dotnet", ["run", "--project", "src/Api"], null],
    ["dotnet", ["watch", "test"], null],
    ["dotnet", ["bin/Api.dll"], null],
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

  test("looks inside bash -c", () => {
    expect(classifyCommandString("bash -c 'cd api && dotnet test'")).toEqual(["dotnet"]);
    expect(classifyCommandString('sh -c "pnpm build"')).toEqual(["node"]);
  });

  test("ignores light commands and explicit bypass", () => {
    expect(classifyCommandString("git status && ls -la")).toEqual([]);
    expect(classifyCommandString("BOUNCER_BYPASS=1 dotnet test")).toEqual([]);
    expect(classifyCommandString("dotnet --info | head")).toEqual([]);
  });
});

describe("generic tools", () => {
  test.each([
    ["cargo", ["build", "--release"], "rust"],
    ["cargo", ["test"], "rust"],
    ["cargo", ["--version"], null],
    ["cargo", ["fmt"], null],
    ["go", ["test", "./..."], "go"],
    ["go", ["mod", "tidy"], null],
    ["go", ["run", "."], null],
    ["cargo", ["run", "--release"], null],
    ["gradle", ["bootRun"], null],
    ["mvn", ["spring-boot:run"], null],
    ["swift", ["build", "-c", "release"], "xcode"],
    ["gradle", ["build"], "jvm"],
    ["mvn", ["-q", "package"], "jvm"],
    ["docker", ["build", "-t", "x", "."], "docker"],
    ["docker", ["compose", "build"], "docker"],
    ["docker", ["compose", "up"], null],
    ["docker", ["ps"], null],
  ] as const)("%s %j -> %s", (tool, args, slot) => {
    expect(classifyInvocation(tool, [...args])).toBe(slot);
  });

  test("custom rules from policy apply, including in command strings", () => {
    const rules = { bazel: { slot: "jvm", heavy: ["build", "test"] } };
    expect(classifyInvocation("bazel", ["test", "//..."], rules)).toBe("jvm");
    expect(classifyCommandString("cd x && bazel build //app", rules)).toEqual(["jvm"]);
    expect(classifyCommandString("cargo build", rules)).toEqual([]);
  });
});

import { safeToRestart } from "../src/classify";

describe("safeToRestart", () => {
  test.each([
    ["dotnet", ["test"], true],
    ["dotnet", ["build"], true],
    ["dotnet", ["ef", "database", "update"], false],
    ["dotnet", ["publish", "-c", "Release"], false],
    ["pnpm", ["test"], true],
    ["pnpm", ["install"], false],
    ["pnpm", ["--filter", "web", "add", "zod"], false],
    ["npm", ["run", "build"], true],
    ["npm", ["ci"], false],
    ["yarn", [], false],
    ["cargo", ["build"], true],
    ["cargo", ["install", "ripgrep"], false],
  ] as const)("%s %j -> %s", (tool, args, safe) => {
    expect(safeToRestart(tool, [...args])).toBe(safe);
  });

  test("commands Bouncer doesn't understand are never restarted", () => {
    expect(safeToRestart("deploy.sh", [], false)).toBe(false);
  });
});
