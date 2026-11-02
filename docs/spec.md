# Bouncer

**One sentence:** A local process bouncer that watches the Mac's load, makes every heavy build, test and agent job wait its turn, and makes sure the Mac never fries.
**Status:** v0.2 built and installed (2026-11-02) · **Owner:** Eirik · **Date:** 2026-11-02

## Problem

Eirik runs many Claude Code and Codex sessions in cmux at once. When several agents start tests, builds and dotnet processes together, the M3 Pro (18 GB) runs out of memory, macOS kills processes, and cmux crashes, taking every session's context with it. Recovery takes ~5 minutes of waiting. Measured: 2 Jetsam events on 2026-11-01 (18:02, 23:33). The 23:33 one had ~34 GB demanded on 18 GB, with `VBCSCompiler` (the Roslyn compiler server, which lingers after builds) alone at 12.6 GB.

## Doing nothing

Eirik keeps hand-serialising agents (rule: one dotnet, no parallel agents) and still crashes when he forgets.

## Done looks like

With 10 agent sessions running for a full workday:

- 0 Jetsam events (baseline: 2/day). Bouncer watches `/Library/Logs/DiagnosticReports` and notifies on any new one.
- 0 cmux crashes
- no agent fails because it was denied: heavy commands wait, then run
- `bouncer status` shows who's waiting, for what, and why
- "prioritize this" in a session moves its jobs to the front within seconds, killing and requeueing a running normal job if needed

The original "swap under 8 GB" target was dropped: measured on 2026-11-02, swap sat at 9-12 GB while pressure was "normal" with 74% free. Swap is shown, never gated on.

## Shipped after v0.1 (same day)

- **Status everywhere:** Claude Code statusline segment, cmux Dock control (`bouncer watch`), menu bar app.
- **Builds outside Bouncer** (IDE, sessions started before install) detected from the process table; they hold slots but are never preempted or reaped. The compiler-server reaper never fires while one runs.
- **Sessions as load:** Claude/Codex sessions with tree memory, uptime, idle time, folder; plain-language advice.
- **Scheduling:** `--at`, `--in`, `--when-idle`; only an env allowlist is stored.
- **Janitor:** dry run by default; caches via their own tools; build output only in worktrees idle 14d+, only if git says ignored; worktrees and untracked folders are reported, never deleted.

## Still out of scope

MCP server · Codex native hook · history charts · Linux and Windows (the `platform/` boundary exists) · signing, notarizing, Homebrew.

## How it works

```text
Claude Code PreToolUse hook ──┐
PATH shims (dotnet, pnpm,     ├──▶ ~/.bouncer/bouncer.sock ──▶ bouncerd (launchd)
  npm, npx, yarn, xcodebuild) │      JSON lines, protocol v1     ├─ sensors (platform/macos)
UserPromptSubmit hook ────────┤      connection = lease          ├─ scheduler (pure, tested)
bouncer CLI ──────────────────┘                                  ├─ reaper
                                                                 └─ jobs.db (history)
```

**Stack:** TypeScript on Bun, one `bun build --compile` binary for daemon, client, CLI, shims and hooks. Chosen over Swift because the goal is a downloadable app; over Node because of single-binary compile and fast startup (shim overhead measured at 20-40 ms per call).

**States:** `queued → running → done`; `running → (preempt) → queued` at the front; `running → reaped` (memory critical, terminal, never retried); `queued|running → cancelled` (client gone or `bouncer cancel`).

**Lease model:** the client connection that admitted a job is its lease. If the shim dies, the slot frees. Live state is in memory; `jobs.db` is history only.

**Gate:** kernel pressure level (`kern.memorystatus_vm_pressure_level`) and free % (`kern.memorystatus_level`).

| Load | When | Effect |
|---|---|---|
| green | pressure normal, free ≥ 25% | slots + `maxConcurrent` |
| yellow | pressure warn or free < 25% | one heavy job at a time (high priority exempt) |
| red | pressure critical or free < 12% | nothing starts; newest normal job reaped every 30 s; notification |

**Where the wait happens:**
- Claude Code: the PreToolUse hook probes the daemon. If the command would queue, it returns `updatedInput` with `run_in_background: true` (bypass mode) so the wait can't hit the Bash tool timeout. In other permission modes it denies with instructions to resubmit in the background, because `allow` would also skip the user's permission prompt. **Verified live 2026-11-02:** a fresh session's `dotnet test` was backgrounded, waited 38 s, ran, and the agent was notified.
- Terminal and Codex: the shim blocks in the foreground until its turn.

**Session identity:** `CLAUDE_CODE_SESSION_ID` (exported by Claude Code into every Bash command), then `CMUX_PANEL_ID`, then the parent pid.

**Priority:** only from the human. `UserPromptSubmit` hook matches the verb "prioritize/prioriter" in the user's own prompt; `bouncer prioritize <job|session>` from the CLI. Agents cannot raise their own priority. Lasts 60 min. Preemption = kill + requeue at the front (pausing frees no RAM when swap is full).

**Compiler servers:** VBCSCompiler, MSBuild `/nodemode` workers and the Razor server are killed 30 s after the last dotnet job ends, or immediately when load is red. Matched on executable and first argument only, never on free text (a bug caught in testing: matching on the command line killed a shell that mentioned the name).

**Nested calls:** a job's child gets `BOUNCER_JOB`; any shim seeing it runs the real tool directly, so `pnpm build` spawning `pnpm` or `dotnet test` spawning `dotnet` never deadlocks.

## Failure modes

| Case | Behavior |
|---|---|
| Daemon down | **fail open**: shims run the command unguarded with a one-line warning; hooks do nothing |
| Daemon dies while a job is queued | shim runs it unguarded |
| Shim killed while queued or running | lease closes, slot frees |
| Client ignores a stop request | daemon kills the job's process tree after 2× the grace period |
| Session started before install | hook sees no shims on PATH and stays out of the way |
| Preempted job | killed, requeued at the front, rerun from the start; the agent sees one longer run with a `[bouncer]` note |

## Rollout

- `bouncer uninstall` removes hooks, shims, PATH line and the launchd job (backups of every edited file are written as `*.bak-bouncer-<stamp>`). `BOUNCER_BYPASS=1` skips the gate per command.
- `~/.bouncer/daemon.log` logs every queue, run, done, preempt, reap and load change.

## Open questions

- **UNKNOWN:** gate thresholds are first guesses. Calibrate from the first Jetsam event Bouncer reports (it notifies).
- **UNKNOWN:** per-job RAM/time budgets for the reaper (v1 only reaps on red load).
- **UNKNOWN:** whether Codex has a pre-tool hook. Shims cover its builds regardless, but its waits are foreground.
- **UNKNOWN:** heavy work not started through a shim (IDE builds, `docker compose`, Postgres) is invisible to the slots; only its memory effect shows in the gate.
