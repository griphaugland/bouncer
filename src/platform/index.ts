import { macos } from "./macos";
import type { Platform, Proc } from "./types";

export type { LoadSample, Platform, Proc } from "./types";

export function getPlatform(): Platform {
  if (process.platform === "darwin") return macos;
  throw new Error(`Bouncer does not support ${process.platform} yet (only macOS).`);
}

export function descendants(procs: Proc[], rootPid: number): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: Proc[] = [];
  const stack = [rootPid];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * Long-lived servers a dotnet build leaves behind. VBCSCompiler held 12.6 GB in the
 * 2026-11-01 23:33 Jetsam event with no build running.
 *
 * Matches on the executable and its first argument only, never on free text: a shell, grep or
 * editor whose command line merely mentions "VBCSCompiler" must not be killed.
 */
export function isCompilerServer(command: string): boolean {
  const [exe = "", arg1 = "", ...rest] = command.split(/\s+/);
  const exeName = exe.split("/").pop() ?? "";
  if (exeName === "VBCSCompiler") return true;
  if (exeName !== "dotnet") return false;
  const dll = arg1.split("/").pop() ?? "";
  if (dll === "VBCSCompiler.dll") return true;
  if (dll === "MSBuild.dll") return rest.some((a) => /^[-/]nodemode:/i.test(a));
  if (dll === "rzc.dll") return rest.includes("server");
  return false;
}

export function compilerServers(procs: Proc[]): Proc[] {
  return procs.filter((p) => p.pid !== process.pid && isCompilerServer(p.command));
}

/** SIGTERM a process and everything under it; SIGKILL whatever is left after `graceMs`. */
export async function killTree(platform: Platform, pid: number, graceMs: number): Promise<void> {
  const targets = [pid, ...descendants(platform.listProcesses(), pid).map((p) => p.pid)];
  for (const t of targets) {
    try {
      process.kill(t, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!targets.some(alive)) return;
    await Bun.sleep(200);
  }
  for (const t of targets) {
    try {
      process.kill(t, "SIGKILL");
    } catch {}
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
