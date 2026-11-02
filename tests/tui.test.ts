import { expect, test } from "bun:test";
import { answer, initState, parseKey, reduce, render, summary } from "../src/tui";

const agents = [
  { label: "Claude Code", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Gemini CLI", value: "gemini", disabled: true, hint: "not installed" },
  { label: "Grok", value: "grok" },
];

test("keys map to actions", () => {
  expect(["\x1b[A", "\x1b[B", " ", "\r", "\x03", "\x1b", "a", "n", "x"].map(parseKey)).toEqual([
    "up",
    "down",
    "space",
    "enter",
    "cancel",
    "cancel",
    "all",
    "none",
    "other",
  ]);
});

test("multi-select: toggles, skips disabled rows, wraps around", () => {
  let s = initState("Agents", agents, true, ["claude"]);
  expect(answer(s)).toEqual(["claude"]);
  s = reduce(s, "down"); // codex
  s = reduce(s, "space");
  s = reduce(s, "down"); // skips gemini → grok
  expect(s.cursor).toBe(3);
  s = reduce(s, "down"); // wraps to claude
  expect(s.cursor).toBe(0);
  expect(answer(s)).toEqual(["claude", "codex"]);
});

test("disabled rows can't be checked, even with 'all'", () => {
  let s = initState("Agents", agents, true);
  s = reduce(s, "all");
  expect(answer(s)).toEqual(["claude", "codex", "grok"]);
  s = reduce(s, "none");
  expect(answer(s)).toEqual([]);
});

test("single-select starts on the initial value and returns where the cursor is", () => {
  const sizes = [
    { label: "1-3", value: 2 },
    { label: "4-8", value: 6 },
    { label: "9-15", value: 12 },
  ];
  let s = initState("Sessions", sizes, false, [12]);
  expect(s.cursor).toBe(2);
  s = reduce(reduce(s, "up"), "enter");
  expect(s.done).toBe(true);
  expect(answer(s)).toEqual([6]);
});

test("render and summary", () => {
  const s = initState("Which agents should Bouncer connect to?", agents, true, ["claude"]);
  const lines = render(s);
  expect(lines[0]).toContain("Which agents");
  expect(lines[1]).toContain("› ● Claude Code");
  expect(lines[3]).toContain("not installed");
  expect(summary(s, "Agents")).toContain("Agents  Claude Code");
});
