import { describe, expect, test } from "bun:test";
import { advise, agentSessions, externalJobs, heavySlotOfProcess } from "../src/observe";
import { parseDuration } from "../src/platform/macos";
import type { Proc } from "../src/platform";

const p = (pid: number, ppid: number, command: string, rssKb = 1024, extra: Partial<Proc> = {}): Proc => ({
  pid,
  ppid,
  rssKb,
  cpuSec: 0,
  elapsedSec: 60,
  command,
  ...extra,
});

describe("heavySlotOfProcess", () => {
  test.each([
    ["/opt/homebrew/bin/dotnet test", "dotnet"],
    ["dotnet run --project src/Api", "dotnet"],
    ["node /opt/homebrew/bin/pnpm test", "node"],
    ["node /Users/x/.nvm/versions/node/v22/lib/node_modules/npm/bin/npm-cli.js run build", "node"],
    ["node /repo/node_modules/vitest/vitest.mjs run", "node"],
    ["node /repo/node_modules/typescript/bin/tsc --noEmit", "node"],
    ["node /repo/node_modules/next/dist/bin/next build", "node"],
    ["/usr/bin/xcodebuild -scheme App build", "xcode"],
  ])("%s -> %s", (cmd, slot) => expect(heavySlotOfProcess(cmd)).toBe(slot));

  test.each([
    "dotnet /sdk/Roslyn/bincore/VBCSCompiler.dll -pipename:x",
    "node /opt/homebrew/bin/pnpm dev",
    "node /repo/node_modules/next/dist/bin/next dev",
    "node /repo/node_modules/vitest/vitest.mjs --watch",
    "node /repo/node_modules/typescript/lib/tsserver.js",
    "node /ext/vscode-eslint/server/out/eslintServer.js --stdio",
    "/bin/zsh -c dotnet test",
    "grep vitest",
  ])("light: %s", (cmd) => expect(heavySlotOfProcess(cmd)).toBeNull());
});

describe("externalJobs", () => {
  const isBouncer = (c: string) => c.includes("/.bouncer/bouncer");

  test("counts only the root of an unmanaged build tree", () => {
    const procs = [
      p(10, 1, "/bin/zsh"),
      p(11, 10, "node /opt/homebrew/bin/pnpm test", 50_000),
      p(12, 11, "node /repo/node_modules/vitest/vitest.mjs run", 400_000),
    ];
    const ext = externalJobs(procs, isBouncer);
    expect(ext.map((e) => e.pid)).toEqual([11]);
    expect(ext[0]!.rssMb).toBe(439);
  });

  test("ignores builds Bouncer is already running", () => {
    const procs = [
      p(20, 1, "/Users/x/.bouncer/bouncer shim dotnet test"),
      p(21, 20, "/opt/homebrew/bin/dotnet test"),
      p(22, 21, "dotnet exec testhost.dll"),
    ];
    expect(externalJobs(procs, isBouncer)).toEqual([]);
  });
});

describe("agentSessions", () => {
  test("finds top-level Claude and Codex sessions with their whole tree's memory", () => {
    const procs = [
      p(1, 0, "/sbin/launchd"),
      p(100, 1, "/Users/x/.local/bin/claude --session-id 0b1ba2a9-b64e-4ae8-ac79-86349c0f1034 --settings y", 400_000),
      p(101, 100, "node mcp-server.js", 100_000),
      p(102, 100, "/Users/x/.local/bin/claude --agent", 50_000),
      p(200, 1, "node /Users/x/.nvm/versions/node/v22/bin/codex"),
      p(201, 200, "/Users/x/.nvm/versions/node/v22/lib/node_modules/@openai/codex/node_modules/@openai/codex/vendor/codex/codex", 20_000),
    ];
    const s = agentSessions(procs);
    expect(s.map((x) => [x.pid, x.kind])).toEqual([
      [100, "claude"],
      [201, "codex"],
    ]);
    expect(s[0]!.sessionId).toBe("0b1ba2a9-b64e-4ae8-ac79-86349c0f1034");
    expect(s[0]!.rssMb).toBe(537);
  });
});

describe("advise", () => {
  test("recommends closing idle sessions and restarting unmanaged ones", () => {
    const out = advise({
      sessions: [
        { pid: 1, kind: "claude", rssMb: 900, idleSec: 7200 },
        { pid: 2, kind: "claude", rssMb: 300, idleSec: 10 },
      ],
      external: [{ pid: 9, slot: "dotnet", command: "/opt/homebrew/bin/dotnet test", rssMb: 1200, elapsedSec: 30 }],
      compilerServerMb: 0,
      freePercent: 50,
      idleThresholdSec: 3600,
    });
    expect(out[0]).toContain("1 agent session idle for 1h+ hold 0.9 GB");
    expect(out[1]).toContain("pid 9 is a dotnet build outside Bouncer");
  });
});

test("parseDuration handles ps formats", () => {
  expect(parseDuration("82:09.54")).toBeCloseTo(4929.54);
  expect(parseDuration("01:02:03")).toBe(3723);
  expect(parseDuration("2-01:00:00")).toBe(176_400);
});
