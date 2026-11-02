# Bouncer

Makes heavy builds, tests and agent jobs wait their turn, so running ten AI agents at once never runs your Mac out of memory.

```text
agent: dotnet test ──▶ shim ──▶ bouncerd: slot free and memory OK?  ── yes ──▶ run
                                                                  └── no  ──▶ wait in line
```

## Install

```sh
bun install
bun run install-local      # build + install daemon (launchd), shims, Claude Code hooks, PATH
```

Open a new shell / start new agent sessions to pick up the shims.

## Use

```sh
bouncer status             # load, slots, jobs, outside builds, sessions, advice
bouncer watch              # live view (installed as a cmux Dock control)
bouncer status --segment   # compact, appended to your Claude Code statusline by install
bouncer history 20
bouncer prioritize <job>   # or type "prioritize this" in a Claude Code session
bouncer cancel <job>
bouncer run -- <cmd>       # gate any command
bouncer schedule --at 02:00 -- pnpm test     # or --in 30m, --when-idle; logs in ~/.bouncer/logs
bouncer scheduled / unschedule s3
bouncer clean              # dry run: caches, idle-worktree build output, big idle worktrees
bouncer clean --apply pnpm-store worktree-build-output
BOUNCER_BYPASS=1 dotnet test
bouncer uninstall [--purge]
```

Policy lives in `~/.bouncer/policy.yaml` and reloads on save. Daemon log: `~/.bouncer/daemon.log`.

## Menu bar app

```sh
menubar/build.sh           # builds ~/Applications/Bouncer.app (through Bouncer's own xcode slot)
open ~/Applications/Bouncer.app
~/Applications/Bouncer.app/Contents/MacOS/BouncerBar --snapshot /tmp/snap   # light/dark PNGs, for design QA
```

It reads `bouncer status --json`; the CLI is the API. Design context: `.impeccable.md`.

## Develop

```sh
bun test
bun run typecheck
BOUNCER_HOME=/tmp/bh bun src/main.ts daemon   # isolated daemon, nothing touches ~/.bouncer
```

Layout: `scheduler.ts` (all admission decisions, pure), `observe.ts` (outside builds, sessions, advice; pure), `schedule.ts`, `janitor.ts`, `daemon.ts` (socket + loop), `run.ts` (shim/client), `hooks.ts`, `install.ts`, `platform/` (OS-specific; macOS only today). Spec: `docs/spec.md`.
