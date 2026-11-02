/** Split a newline-delimited buffer into complete lines and the unfinished remainder. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim()), rest };
}
