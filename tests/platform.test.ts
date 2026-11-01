import { describe, expect, test } from "bun:test";
import { descendants, isCompilerServer, type Proc } from "../src/platform";

describe("isCompilerServer", () => {
  test.each([
    "/usr/local/share/dotnet/sdk/10.0.400/Roslyn/bincore/VBCSCompiler -pipename:abc",
    "/opt/homebrew/bin/dotnet /usr/local/share/dotnet/sdk/10.0.400/Roslyn/bincore/VBCSCompiler.dll -pipename:abc",
    "dotnet /sdk/MSBuild.dll /noautoresponse /nologo /nodemode:1 /nodeReuse:true",
    "dotnet /sdk/Sdks/Microsoft.NET.Sdk.Razor/tools/rzc.dll server -p abc",
  ])("matches %s", (cmd) => expect(isCompilerServer(cmd)).toBe(true));

  // The 2026-11-02 bug: these mention the name but are not the server. Killing them killed a shell.
  test.each([
    "/bin/zsh -c bash -c 'exec -a /fake/VBCSCompiler sleep 300'",
    "grep VBCSCompiler",
    "vim notes-about-VBCSCompiler.md",
    "dotnet build /nodemode:1",
    "dotnet /sdk/MSBuild.dll build.proj",
    "/Users/x/.local/bin/claude --resume",
  ])("does not match %s", (cmd) => expect(isCompilerServer(cmd)).toBe(false));
});

describe("descendants", () => {
  test("walks the whole tree", () => {
    const procs = [
      [2, 1, "a"],
      [3, 2, "b"],
      [4, 3, "c"],
      [5, 1, "other"],
    ].map(([pid, ppid, command]) => ({ pid, ppid, rssKb: 0, cpuSec: 0, elapsedSec: 0, command }) as Proc);
    expect(descendants(procs, 2).map((p) => p.pid).sort()).toEqual([3, 4]);
  });
});
