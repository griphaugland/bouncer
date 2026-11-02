// Terminal styling, in one place. Colour is on only for a real terminal, and never when NO_COLOR
// is set (no-color.org) or TERM=dumb; FORCE_COLOR turns it on for pipes.
//
// Visual language: hierarchy comes from weight and dimness, not colour. Colour carries meaning
// only: green/yellow/red for state, yellow for "worth your attention". No emoji.

type Stream = { isTTY?: boolean; columns?: number };

function colorOn(stream: Stream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY && process.env.TERM !== "dumb";
}

function styler(stream: Stream) {
  const on = colorOn(stream);
  const wrap = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    on,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
  };
}

export const out = styler(process.stdout);
export const err = styler(process.stderr);

export type Tone = "green" | "yellow" | "red";
export const tone = (t: Tone, s: string) => out[t](s);

/** Columns available, with a sane fallback for pipes. */
export function width(): number {
  return Math.max(60, Math.min(process.stdout.columns || 100, 140));
}

/** Visible length, ignoring ANSI escapes, so padding lines up whether or not colour is on. */
export function visible(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function padEnd(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - visible(s)));
}

export function padStart(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - visible(s))) + s;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

export const mark = {
  ok: () => out.green("✓"),
  warn: () => out.yellow("!"),
  fail: () => out.red("✗"),
  dot: (t: Tone) => tone(t, "●"),
  arrow: () => out.yellow("→"),
};
