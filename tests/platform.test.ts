import { describe, expect, test } from "bun:test";
import { descendants, isCompilerServer } from "../src/platform";

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
      { pid: 2, ppid: 1, rssKb: 0, command: "a" },
      { pid: 3, ppid: 2, rssKb: 0, command: "b" },
      { pid: 4, ppid: 3, rssKb: 0, command: "c" },
      { pid: 5, ppid: 1, rssKb: 0, command: "other" },
    ];
    expect(descendants(procs, 2).map((p) => p.pid).sort()).toEqual([3, 4]);
  });
});
