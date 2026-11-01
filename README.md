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
bouncer status             # load, slots, running and queued jobs, biggest memory users
bouncer status --line      # one line, for a statusline
bouncer history 20
bouncer prioritize <job>   # or type "prioritize this" in a Claude Code session
bouncer cancel <job>
bouncer run -- <cmd>       # gate any command
BOUNCER_BYPASS=1 dotnet test
bouncer uninstall [--purge]
```

Policy lives in `~/.bouncer/policy.yaml` and reloads on save. Daemon log: `~/.bouncer/daemon.log`.

## Develop

```sh
bun test
bun run typecheck
BOUNCER_HOME=/tmp/bh bun src/main.ts daemon   # isolated daemon, nothing touches ~/.bouncer
```

Layout: `scheduler.ts` (all admission decisions, pure), `daemon.ts` (socket + loop), `run.ts` (shim/client), `hooks.ts`, `install.ts`, `platform/` (OS-specific; macOS only today). Spec: `docs/spec.md`.
