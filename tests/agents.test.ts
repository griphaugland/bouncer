import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, isBouncerHook } from "../src/agents";

// Each test runs in a throwaway HOME. The invariant that matters: disconnect leaves the user's
// files exactly as they were before connect.

let home: string;
const realHome = process.env.HOME;
const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bouncer-agents-"));
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

afterEach(() => {
  process.env.HOME = realHome;
  if (saved.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
  if (saved.CODEX_HOME) process.env.CODEX_HOME = saved.CODEX_HOME;
  rmSync(home, { recursive: true, force: true });
});

const agent = (id: string) => agents().find((a) => a.id === id)!;
const read = (p: string) => readFileSync(p, "utf8");

describe("Claude Code", () => {
  test("adds hooks and statusline next to the user's own, and removes only its own", () => {
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    const original = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-hook" }] }] },
      statusLine: { type: "command", command: "echo mine" },
      model: "opus",
    };
    writeFileSync(file, JSON.stringify(original, null, 2));

    expect(agent("claude").connect()).toEqual([file]);
    const connected = JSON.parse(read(file));
    expect(connected.hooks.UserPromptSubmit).toHaveLength(2);
    expect(connected.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(connected.statusLine.command).toStartWith("echo mine; printf ' '; ");
    expect(agent("claude").connected()).toBe(true);

    agent("claude").disconnect();
    expect(JSON.parse(read(file))).toEqual(original);
  });

  test("a Claude Code that was never configured gets a settings file", () => {
    mkdirSync(join(home, ".claude"));
    agent("claude").connect();
    expect(JSON.parse(read(join(home, ".claude", "settings.json"))).hooks.PreToolUse).toHaveLength(1);
  });

  test("removes hooks installed by older versions (unquoted path)", () => {
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    const legacy = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/Users/x/.bouncer/bouncer hook pre-tool" }] },
        ],
      },
    };
    writeFileSync(file, JSON.stringify(legacy));
    agent("claude").disconnect();
    expect(JSON.parse(read(file))).toEqual({});
  });
});

describe("Codex", () => {
  test("writes hooks.json with a top-level hooks key and a note in AGENTS.md, and undoes both", () => {
    const codex = join(home, ".codex");
    mkdirSync(codex);
    writeFileSync(join(codex, "AGENTS.md"), "# My rules\n\nBe brief.\n");
    expect(agent("codex").detect()).toBe(codex);

    agent("codex").connect();
    const hooks = JSON.parse(read(join(codex, "hooks.json")));
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain("hook pre-tool --agent codex");
    expect(hooks.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hook prompt --agent codex");
    expect(read(join(codex, "AGENTS.md"))).toStartWith("# My rules\n\nBe brief.\n");
    expect(read(join(codex, "AGENTS.md"))).toContain("## Bouncer (build queue on this Mac)");

    agent("codex").disconnect();
    expect(JSON.parse(read(join(codex, "hooks.json")))).toEqual({});
    expect(read(join(codex, "AGENTS.md"))).toBe("# My rules\n\nBe brief.\n");
  });

  test("puts the note in AGENTS.override.md when that's the file Codex reads", () => {
    const codex = join(home, ".codex");
    mkdirSync(codex);
    writeFileSync(join(codex, "AGENTS.override.md"), "override\n");
    agent("codex").connect();
    expect(read(join(codex, "AGENTS.override.md"))).toContain("bouncer:start");
  });

  test("connecting twice doesn't duplicate anything", () => {
    mkdirSync(join(home, ".codex"));
    agent("codex").connect();
    agent("codex").connect();
    const text = read(join(home, ".codex", "AGENTS.md"));
    expect(text.split("bouncer:start").length - 1).toBe(1);
    expect(JSON.parse(read(join(home, ".codex", "hooks.json"))).hooks.PreToolUse).toHaveLength(1);
  });
});

describe("Gemini CLI", () => {
  test("adds and removes a note in GEMINI.md, keeping the rest", () => {
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "GEMINI.md"), "Keep answers short.\n");
    agent("gemini").connect();
    expect(agent("gemini").connected()).toBe(true);
    agent("gemini").disconnect();
    expect(read(join(home, ".gemini", "GEMINI.md"))).toBe("Keep answers short.\n");
  });
});

test("isBouncerHook matches quoted and unquoted, and nothing else", () => {
  expect(isBouncerHook('"/Users/a b/.bouncer/bouncer" hook pre-tool --agent codex')).toBe(true);
  expect(isBouncerHook("/Users/x/.bouncer/bouncer hook prompt")).toBe(true);
  expect(isBouncerHook("/usr/local/bin/my-hook")).toBe(false);
  expect(isBouncerHook("echo bouncer hook-ish")).toBe(false);
});
