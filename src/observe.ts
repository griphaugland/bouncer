import { basename } from "node:path";
import { classifyInvocation } from "./classify";
import { descendants, isCompilerServer, type Proc } from "./platform";

// Pure readings of a process snapshot. The daemon decides what to do with them.

const NODE_SCRIPT_TOOL: Record<string, string> = {
  "pnpm.cjs": "pnpm",
  "pnpm.js": "pnpm",
  pnpm: "pnpm",
  "npm-cli.js": "npm",
  npm: "npm",
  "npx-cli.js": "npx",
  npx: "npx",
  "yarn.js": "yarn",
  yarn: "yarn",
};

// Test runners and compilers launched directly by node, e.g. by an IDE or an unshimmed session.
const NODE_HEAVY_SCRIPT =
  /(\/vitest\/vitest\.mjs|\/jest(-cli)?\/bin\/jest|\/typescript\/bin\/tsc|\/\.bin\/tsc|\/playwright(\/cli)?\.js|\/eslint\/bin\/eslint\.js)(\s|$)|\/next\/dist\/bin\/next\s+build|\/vite\/bin\/vite\.js\s+build/;
const WATCHING = /\s(--watch|-w|watch|dev|serve|start)(\s|$)/;

/** Which slot a running process occupies, judged from its command line alone. */
export function heavySlotOfProcess(command: string): string | null {
  if (isCompilerServer(command)) return null;
  const [exe = "", ...args] = command.split(/\s+/);
  const name = basename(exe);
  if (name === "dotnet" || name === "xcodebuild") return classifyInvocation(name, args);
  if (name === "node") {
    const script = args.find((a) => !a.startsWith("-"));
    const tool = script ? NODE_SCRIPT_TOOL[basename(script)] : undefined;
    if (tool) return classifyInvocation(tool, args.slice(args.indexOf(script!) + 1));
    if (NODE_HEAVY_SCRIPT.test(command) && !WATCHING.test(command)) return "node";
  }
  return null;
}

export interface ExternalJob {
  pid: number;
  slot: string;
  command: string;
  rssMb: number;
  elapsedSec: number;
}

function ancestors(byPid: Map<number, Proc>, p: Proc): Proc[] {
  const out: Proc[] = [];
  let cur = byPid.get(p.ppid);
  for (let guard = 0; cur && guard < 64; guard++) {
    out.push(cur);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/**
 * Heavy builds Bouncer did not start: an IDE build, a session started before install, a
 * BOUNCER_BYPASS run. Only the root of each build tree counts, and anything under a Bouncer
 * process (a gated job) is excluded, so a tracked job is never counted twice.
 */
export function externalJobs(procs: Proc[], isBouncer: (command: string) => boolean): ExternalJob[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: ExternalJob[] = [];
  for (const p of procs) {
    const slot = heavySlotOfProcess(p.command);
    if (!slot) continue;
    const up = ancestors(byPid, p);
    if (up.some((a) => isBouncer(a.command) || heavySlotOfProcess(a.command))) continue;
    const rssKb = p.rssKb + descendants(procs, p.pid).reduce((s, d) => s + d.rssKb, 0);
    out.push({ pid: p.pid, slot, command: p.command, rssMb: Math.round(rssKb / 1024), elapsedSec: p.elapsedSec });
  }
  return out;
}

export type SessionKind = "claude" | "codex";

export interface AgentSession {
  pid: number;
  kind: SessionKind;
  sessionId?: string;
  /** The session process plus everything under it (MCP servers, shells, its builds). */
  rssMb: number;
  elapsedSec: number;
  cpuSec: number;
}

export function sessionKind(command: string): SessionKind | null {
  const exe = command.split(/\s+/)[0] ?? "";
  if (/\/claude\/versions\/[^/]+$/.test(exe) || basename(exe) === "claude") return "claude";
  if (/@openai\/codex\/.*\/codex$/.test(exe)) return "codex";
  return null;
}

/** Top-level agent sessions (a session process whose parent is not the same kind of session). */
export function agentSessions(procs: Proc[]): AgentSession[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: AgentSession[] = [];
  for (const p of procs) {
    const kind = sessionKind(p.command);
    if (!kind) continue;
    const parent = byPid.get(p.ppid);
    if (parent && sessionKind(parent.command) === kind) continue;
    const rssKb = p.rssKb + descendants(procs, p.pid).reduce((s, d) => s + d.rssKb, 0);
    out.push({
      pid: p.pid,
      kind,
      sessionId: p.command.match(/--session-id\s+([0-9a-f-]{36})/)?.[1],
      rssMb: Math.round(rssKb / 1024),
      elapsedSec: p.elapsedSec,
      cpuSec: p.cpuSec,
    });
  }
  return out;
}

export interface AdviceInput {
  sessions: { pid: number; kind: SessionKind; rssMb: number; idleSec: number; cwd?: string }[];
  external: ExternalJob[];
  compilerServerMb: number;
  freePercent: number;
  idleThresholdSec: number;
}

/** Plain-language suggestions. Bouncer never closes a session itself: that loses context. */
export function advise(input: AdviceInput): string[] {
  const out: string[] = [];
  const idle = input.sessions.filter((s) => s.idleSec >= input.idleThresholdSec);
  if (idle.length) {
    const mb = idle.reduce((s, x) => s + x.rssMb, 0);
    const hours = Math.round(input.idleThresholdSec / 3600);
    out.push(
      `${idle.length} agent session${idle.length > 1 ? "s" : ""} idle for ${hours}h+ hold ${(mb / 1024).toFixed(1)} GB. Closing them is the biggest win (see Sessions below).`,
    );
  }
  for (const e of input.external) {
    out.push(
      `pid ${e.pid} is a ${e.slot} build outside Bouncer (${Math.round(e.rssMb)} MB): ${shorten(e.command)}. Restart that session so its builds queue.`,
    );
  }
  if (input.compilerServerMb > 500) {
    out.push(`dotnet compiler servers hold ${Math.round(input.compilerServerMb)} MB; Bouncer stops them once dotnet goes idle.`);
  }
  if (input.freePercent < 25 && !idle.length) {
    const top = [...input.sessions].sort((a, b) => b.rssMb - a.rssMb)[0];
    if (top) out.push(`Memory is tight. The largest session is pid ${top.pid} (${top.rssMb} MB${top.cwd ? `, ${top.cwd}` : ""}).`);
  }
  return out;
}

function shorten(cmd: string, n = 60): string {
  const parts = cmd.split(/\s+/);
  const exe = basename(parts[0] ?? "");
  const s = [exe, ...parts.slice(1)].join(" ");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
