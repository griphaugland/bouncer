import { mark, out } from "./term";

// Minimal keyboard prompts for the setup wizard. No dependencies. State and rendering are pure
// (tested in tests/tui.test.ts); only `prompt()` touches the terminal.
//
// Once answered, a prompt collapses to one line ("✓ Agents  Claude Code, Codex"), so the wizard
// leaves a readable record in the scrollback instead of a wall of menus.

export interface Option<T> {
  label: string;
  value: T;
  hint?: string;
  /** Shown but not selectable (e.g. an agent that isn't installed). */
  disabled?: boolean;
}

export interface PromptState<T> {
  title: string;
  options: Option<T>[];
  cursor: number;
  multi: boolean;
  checked: boolean[];
  done: boolean;
  cancelled: boolean;
}

export type Key = "up" | "down" | "space" | "enter" | "cancel" | "all" | "none" | "other";

export function parseKey(data: string): Key {
  if (data === "\x1b[A" || data === "k") return "up";
  if (data === "\x1b[B" || data === "j") return "down";
  if (data === " ") return "space";
  if (data === "\r" || data === "\n") return "enter";
  if (data === "\x03" || data === "\x1b" || data === "q") return "cancel";
  if (data === "a") return "all";
  if (data === "n") return "none";
  return "other";
}

export function initState<T>(title: string, options: Option<T>[], multi: boolean, initial: T[] = []): PromptState<T> {
  const firstEnabled = Math.max(
    0,
    options.findIndex((o) => !o.disabled),
  );
  const cursor = multi
    ? firstEnabled
    : Math.max(
        firstEnabled,
        options.findIndex((o) => initial.includes(o.value) && !o.disabled),
      );
  return {
    title,
    options,
    cursor,
    multi,
    checked: options.map((o) => !o.disabled && initial.includes(o.value)),
    done: false,
    cancelled: false,
  };
}

function step<T>(s: PromptState<T>, dir: 1 | -1): number {
  const n = s.options.length;
  for (let i = 1; i <= n; i++) {
    const next = (s.cursor + dir * i + n) % n;
    if (!s.options[next]!.disabled) return next;
  }
  return s.cursor;
}

export function reduce<T>(s: PromptState<T>, key: Key): PromptState<T> {
  switch (key) {
    case "up":
      return { ...s, cursor: step(s, -1) };
    case "down":
      return { ...s, cursor: step(s, 1) };
    case "space": {
      if (!s.multi || s.options[s.cursor]?.disabled) return s;
      const checked = [...s.checked];
      checked[s.cursor] = !checked[s.cursor];
      return { ...s, checked };
    }
    case "all":
      return s.multi ? { ...s, checked: s.options.map((o) => !o.disabled) } : s;
    case "none":
      return s.multi ? { ...s, checked: s.options.map(() => false) } : s;
    case "enter":
      return { ...s, done: true };
    case "cancel":
      return { ...s, cancelled: true };
    default:
      return s;
  }
}

export function answer<T>(s: PromptState<T>): T[] {
  return s.multi ? s.options.filter((_, i) => s.checked[i]).map((o) => o.value) : [s.options[s.cursor]!.value];
}

/** Lines for the live prompt. */
export function render<T>(s: PromptState<T>): string[] {
  const labelWidth = Math.max(...s.options.map((o) => o.label.length));
  const lines = [`${out.yellow("?")} ${out.bold(s.title)}`];
  s.options.forEach((o, i) => {
    const here = i === s.cursor;
    const pointer = here ? out.yellow("›") : " ";
    const box = s.multi ? (s.checked[i] ? out.green("●") : out.dim("○")) : here ? out.green("●") : out.dim("○");
    const label = o.disabled
      ? out.dim(o.label.padEnd(labelWidth))
      : here
        ? out.bold(o.label.padEnd(labelWidth))
        : o.label.padEnd(labelWidth);
    const hint = o.hint ? `  ${out.dim(o.hint)}` : "";
    lines.push(`  ${pointer} ${box} ${label}${hint}`);
  });
  lines.push(
    out.dim(s.multi ? "    ↑↓ move · space toggle · a all · n none · enter confirm" : "    ↑↓ move · enter choose"),
  );
  return lines;
}

/** The one line a prompt leaves behind once answered. */
export function summary<T>(s: PromptState<T>, label = s.title): string {
  const picked = s.options.filter((_, i) => (s.multi ? s.checked[i] : i === s.cursor)).map((o) => o.label);
  // An empty label means the choice speaks for itself ("✓ Install").
  if (!label) return `${mark.ok()} ${out.bold(picked[0] ?? "")}`;
  return `${mark.ok()} ${out.bold(label)}  ${picked.length ? picked.join(", ") : out.dim("none")}`;
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/**
 * Ask in the terminal. Resolves with the chosen values; rejects with Cancelled on Esc/Ctrl-C.
 * Requires an interactive stdin (callers check `interactive()` first).
 */
export function prompt<T>(
  title: string,
  options: Option<T>[],
  opts: { multi?: boolean; initial?: T[]; summaryLabel?: string } = {},
): Promise<T[]> {
  const stdin = process.stdin;
  const write = (t: string) => process.stdout.write(t);
  let state = initState(title, options, !!opts.multi, opts.initial ?? []);
  let drawn = 0;

  const draw = (lines: string[]) => {
    if (drawn) write(`\x1b[${drawn}A\x1b[0J`);
    write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve, reject) => {
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      write("\x1b[?25h");
    };
    const onData = (buf: Buffer) => {
      state = reduce(state, parseKey(buf.toString()));
      if (state.cancelled) {
        draw([`${mark.fail()} ${out.bold(opts.summaryLabel ?? title)}  ${out.dim("cancelled")}`]);
        finish();
        reject(new Cancelled());
      } else if (state.done) {
        const chosen = answer(state);
        draw([summary(state, opts.summaryLabel)]);
        finish();
        resolve(chosen);
      } else draw(render(state));
    };
    write("\x1b[?25l");
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
    draw(render(state));
  });
}

/** Whether we can ask questions: a real terminal on both ends. */
export function interactive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}
