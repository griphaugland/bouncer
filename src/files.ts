import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// Every file Bouncer edits outside ~/.bouncer belongs to the user: back it up first, write
// atomically, and change only a marked block or Bouncer's own entries so uninstall can undo
// exactly what install did.

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/** Copy `file` aside before changing it. Never overwrites an earlier backup, even within a second. */
export function backup(file: string): void {
  if (!existsSync(file)) return;
  const base = `${file}.bak-bouncer-${stamp()}`;
  let target = base;
  for (let n = 2; existsSync(target); n++) target = `${base}-${n}`;
  copyFileSync(file, target);
}

/**
 * Replace a file's content atomically without changing what the file *is*: a symlink (dotfiles
 * managed by stow/chezmoi/yadm) stays a symlink and its target is written, and the original
 * permissions carry over (a 0600 settings file holding tokens must not become 0644).
 */
export function writeAtomic(file: string, content: string): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const tmp = `${target}.tmp-bouncer`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, target);
}

export function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").trim();
  return text ? JSON.parse(text) : {};
}

export function writeJson(file: string, value: unknown): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Remove the block between `start` and `end` markers (inclusive), tidying blank lines. */
export function stripBlock(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) return text;
  const before = text.slice(0, a).replace(/\n+$/, "\n");
  const after = text.slice(b + end.length).replace(/^\n/, "");
  const joined = (before + after).trimEnd();
  return joined ? `${joined}\n` : "";
}

/** Replace (or append) a marked block in a text file. `block` null removes it. Returns whether the file changed. */
export function setBlock(file: string, start: string, end: string, block: string | null): boolean {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  let next = stripBlock(current, start, end);
  if (block !== null) next = `${next}${next ? "\n" : ""}${start}\n${block.trim()}\n${end}\n`;
  if (next === current) return false;
  if (!current && block === null) return false;
  backup(file);
  writeAtomic(file, next);
  return true;
}

export function hasBlock(file: string, start: string): boolean {
  return existsSync(file) && readFileSync(file, "utf8").includes(start);
}
