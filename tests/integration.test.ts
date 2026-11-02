import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

// Real daemon, real clients, isolated BOUNCER_HOME. Nothing touches ~/.bouncer, no notifications,
// no compiler servers killed, load pinned to green.

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
// The test daemon reads the real process table: real builds on this machine must not fill its
// slots (found when a real `dotnet test` elsewhere made the dotnet-slot test wait forever).
const TEST_POLICY =
  "maxConcurrent: 4\nslots:\n  t: 1\n  dotnet: 1\ncountOutsideBuilds: false\nnotifications: false\nreaper:\n  killCompilerServers: false\njanitor:\n  roots: []\n";
let home: string;
let daemon: Subprocess | undefined;
let env: Record<string, string>;

function bouncer(args: string[], extra: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, MAIN, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
}

async function output(args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const p = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

async function status() {
  const r = await output(["status", "--json"]);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`status --json failed (exit ${r.code}): ${r.err.trim() || "no output"}`);
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "bouncer-it-"));
  writeFileSync(join(home, "policy.yaml"), TEST_POLICY);
  env = { ...(process.env as Record<string, string>), BOUNCER_HOME: home, BOUNCER_LOAD_OVERRIDE: "green" };
  delete env.BOUNCER_JOB;
  delete env.BOUNCER_BYPASS;
  daemon = Bun.spawn([process.execPath, MAIN, "daemon"], {
    env,
    stdout: Bun.file(join(home, "daemon.out")),
    stderr: Bun.file(join(home, "daemon.err")),
  });
  await waitFor(() => existsSync(join(home, "bouncer.sock")));
});

afterEach(async () => {
  if (process.env.BOUNCER_TEST_DEBUG) {
    for (const f of ["daemon.err", "daemon.log"]) {
      if (existsSync(join(home, f))) console.log(`--- ${f}\n${readFileSync(join(home, f), "utf8")}`);
    }
    console.log(`--- daemon exit: ${daemon?.exitCode} signal: ${daemon?.signalCode}`);
  }
  daemon?.kill();
  await daemon?.exited;
  rmSync(home, { recursive: true, force: true });
});

// Generous timeouts: CI machines and a Mac under memory pressure (where this tool lives) are slow.
setDefaultTimeout(20_000);

describe("daemon + clients", () => {
  test("a capacity-1 slot runs jobs one after the other", async () => {
    const log = join(home, "order.log");
    const job = (name: string) =>
      bouncer(
        ["run", "--slot", "t", "--", "sh", "-c", `echo ${name}-start >> ${log}; sleep 0.6; echo ${name}-end >> ${log}`],
        {
          BOUNCER_SESSION: name,
        },
      );
    const a = job("a");
    await waitFor(() => existsSync(log));
    const b = job("b");
    await Promise.all([a.exited, b.exited]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("a prioritized session preempts a running job, which reruns afterwards", async () => {
    const log = join(home, "preempt.log");
    const a = bouncer(
      ["run", "--slot", "t", "--", "sh", "-c", `echo a-start >> ${log}; sleep 3; echo a-end >> ${log}`],
      {
        BOUNCER_SESSION: "slow",
      },
    );
    await waitFor(() => existsSync(log));
    expect((await output(["prioritize", "urgent"])).code).toBe(0);
    const b = bouncer(["run", "--slot", "t", "--", "sh", "-c", `echo b-ran >> ${log}`], { BOUNCER_SESSION: "urgent" });
    expect(await b.exited).toBe(0);
    expect(await a.exited).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["a-start", "b-ran", "a-start", "a-end"]);
  }, 15_000);

  test("a client that dies releases its slot", async () => {
    const a = bouncer(["run", "--slot", "t", "--", "sleep", "30"]);
    await waitFor(async () => (await status()).running.length === 1);
    a.kill("SIGKILL");
    const b = await output(["run", "--slot", "t", "--", "echo", "after"]);
    expect(b.out.trim()).toBe("after");
  });

  test("cancel stops a queued job before it starts", async () => {
    const a = bouncer(["run", "--slot", "t", "--", "sleep", "5"]);
    await waitFor(async () => (await status()).running.length === 1);
    const b = bouncer(["run", "--slot", "t", "--", "echo", "never"]);
    await waitFor(async () => (await status()).queued.length === 1);
    const id = (await status()).queued[0].id;
    expect((await output(["cancel", String(id)])).code).toBe(0);
    expect(await b.exited).toBe(130);
    expect(await new Response(b.stdout).text()).toBe("");
    a.kill();
  });

  test("the Claude Code hook backgrounds a command that would queue", async () => {
    const shims = join(home, "bin");
    mkdirSync(shims, { recursive: true });
    const a = bouncer(["run", "--slot", "dotnet", "--", "sleep", "5"]);
    writeFileSync(join(home, "policy.yaml"), `${TEST_POLICY}`);
    await waitFor(async () => (await status()).running.length === 1);
    const input = JSON.stringify({
      session_id: "s1",
      tool_name: "Bash",
      permission_mode: "bypassPermissions",
      tool_input: { command: "dotnet test", description: "tests" },
    });
    const r = await output(["hook", "pre-tool"], { PATH: `${shims}:${process.env.PATH}` }, input);
    const decision = JSON.parse(r.out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe("allow");
    expect(decision.updatedInput).toEqual({ command: "dotnet test", description: "tests", run_in_background: true });
    a.kill();
  });

  test("redacts secrets before they reach status and the log", async () => {
    const a = bouncer(["run", "--slot", "t", "--", "sh", "-c", "GITHUB_TOKEN=ghp_abcdefghijklmnop sleep 2"]);
    await waitFor(async () => (await status()).running.length === 1);
    const s = await status();
    expect(s.running[0].cmd).toContain("GITHUB_TOKEN=***");
    expect(readFileSync(join(home, "daemon.log"), "utf8")).not.toContain("ghp_abcdefghijklmnop");
    a.kill();
  });

  test("a scheduled job runs, logs its output, and records its exit code", async () => {
    expect((await output(["schedule", "--in", "1s", "--", "sh", "-c", "echo scheduled-ran; exit 4"])).code).toBe(0);
    await waitFor(async () => (await output(["scheduled", "--all"])).out.includes("failed"), 10_000);
    const logs = join(home, "logs");
    const file = readdirSync(logs)[0]!;
    expect(readFileSync(join(logs, file), "utf8")).toContain("scheduled-ran");
    expect((await output(["scheduled", "--all"])).out).toContain("exit 4");
  }, 15_000);
});

test("with no daemon, builds fail open and still run", async () => {
  const lonely = mkdtempSync(join(tmpdir(), "bouncer-none-"));
  const p = Bun.spawn([process.execPath, MAIN, "run", "--slot", "t", "--", "echo", "ran"], {
    env: { ...(process.env as Record<string, string>), BOUNCER_HOME: lonely },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await p.exited).toBe(0);
  expect((await new Response(p.stdout).text()).trim()).toBe("ran");
  expect(await new Response(p.stderr).text()).toContain("running unguarded");
  rmSync(lonely, { recursive: true, force: true });
});

test("a stale socket with no daemon behind it fails open immediately, not after the connect timeout", async () => {
  const stale = mkdtempSync(join(tmpdir(), "bouncer-stale-"));
  // A socket file whose listener is gone: what a crashed daemon leaves behind.
  const server = Bun.listen({ unix: join(stale, "bouncer.sock"), socket: { data() {} } });
  server.stop(true);
  if (!existsSync(join(stale, "bouncer.sock"))) writeFileSync(join(stale, "bouncer.sock"), "");
  const started = Date.now();
  const p = Bun.spawn([process.execPath, MAIN, "run", "--slot", "t", "--", "echo", "ran"], {
    env: { ...(process.env as Record<string, string>), BOUNCER_HOME: stale },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await p.exited).toBe(0);
  expect((await new Response(p.stdout).text()).trim()).toBe("ran");
  expect(Date.now() - started).toBeLessThan(3000);
  rmSync(stale, { recursive: true, force: true });
});
