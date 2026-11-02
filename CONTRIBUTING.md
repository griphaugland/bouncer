# Contributing

## Setup

```sh
bun install            # Bun 1.3+
bun run check          # typecheck + lint + every test
```

`bun test` includes daemon integration tests: they start real daemons in temporary
`BOUNCER_HOME`s with the load pinned (`BOUNCER_LOAD_OVERRIDE=green`), notifications off and
compiler-server reaping off, so they never touch your real install or your machine's processes.
`tests/binary.test.ts` runs against `dist/bouncer`; run `bun run build` first.

Try changes without touching your install:

```sh
BOUNCER_HOME=/tmp/bh bun src/main.ts daemon &
BOUNCER_HOME=/tmp/bh bun src/main.ts run --slot dotnet -- sleep 5
BOUNCER_HOME=/tmp/bh bun src/main.ts status
```

## Where things live

| File | Owns |
|---|---|
| `src/scheduler.ts` | every admission decision: slots, queue order, priority, preemption, reaping. Pure; test it there. |
| `src/observe.ts` | reading the process table: builds outside Bouncer, agent sessions, advice. Pure. |
| `src/classify.ts` | which commands are heavy and which slot they need |
| `src/daemon.ts` | socket server, sampling loop, scheduled jobs |
| `src/run.ts` | the shim / client: wait, run, rerun when preempted |
| `src/hooks.ts` | Claude Code hooks |
| `src/platform/` | everything OS-specific (macOS today). A Linux port implements `Platform`. |
| `menubar/` | SwiftUI menu bar app; talks to the daemon only through `bouncer status --json` and the CLI |

## Rules

- **Fail open.** Any error in a shim, hook or client must let the user's command run.
- **Never delete what you can't prove is regenerable.** See `src/janitor.ts`.
- **Agents never get more power than the human.** Anything that reorders or bypasses the queue goes in `HUMAN_ONLY` in `src/hooks.ts`.
- **The protocol is versioned** (`PROTOCOL_VERSION` in `src/protocol.ts`). Additive changes only within a version.
- Bug fixes come with a test that fails without the fix.
- Menu bar UI: render it with `BouncerBar --snapshot <dir> --status-file docs/demo-status.json` and look at both PNGs before opening a PR.

## Releasing

1. Bump `version` in `package.json`, add a `## [x.y.z]` section to `CHANGELOG.md`.
2. Tag `vx.y.z` and push the tag. `.github/workflows/release.yml` checks the tag matches, runs every check, builds both architectures and the universal app, signs and notarizes when the secrets below exist, and publishes the GitHub release with `SHA256SUMS`.

Signing secrets (repository → Settings → Secrets → Actions), all optional:

| Secret | What |
|---|---|
| `APPLE_CERT_P12` | Developer ID Application certificate + key, exported as .p12, base64-encoded |
| `APPLE_CERT_PASSWORD` | password of that .p12 |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | notarytool credentials (an app-specific password) |
