# Changelog

## [0.3.0] - 2026-11-02

First release for other people.

### Added
- `bouncer doctor`: checks install, permissions, daemon, policy, PATH shadowing (nvm and friends) and Claude Code hooks, with a fix for each problem.
- More tools out of the box: `cargo`, `go`, `swift`, `gradle`, `mvn`, `docker build`; add your own under `tools:` in `policy.yaml` and run `bouncer shims`.
- `bouncer --version`; the CLI warns when the running daemon is a different version.
- Release pipeline: arm64 + x64 binaries, universal menu bar app, SHA-256 checksums, optional Developer ID signing and notarization; `install.sh` verifies checksums.

### Security
- `~/.bouncer`, its socket, database and logs are owner-only.
- Command lines are redacted before they reach logs, history, status or notifications.
- The binary no longer loads `.env` / `bunfig.toml` from the directory it runs in. Earlier builds passed each project's `.env` into every gated build.
- The Claude Code hook refuses agent attempts to bypass the queue, reprioritize, cancel, uninstall, or stop the daemon.

### Fixed
- Under memory pressure a swapped-out daemon could take over a second to accept, and shims then ran builds unguarded. Shims now wait up to 10 s for a live daemon; a dead one is still detected instantly.
- The daemon log rotates at 5 MB; history older than 30 days is pruned.

## [0.2.0] - 2026-11-02
- Menu bar app, statusline segment, cmux Dock view (`bouncer watch`).
- Builds Bouncer didn't start hold slots; agent sessions and advice; scheduling; `bouncer clean`.

## [0.1.0] - 2026-11-02
- Daemon, slots and queue, memory-pressure gate, PATH shims, Claude Code hooks, priority with preemption, compiler-server reaper.
