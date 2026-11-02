# Changelog

## [0.5.1] - 2026-11-02

### Fixed
- Installing with Homebrew on a Mac that already had Bouncer left the daemon on the old copy: `bouncer` on PATH resolved to that copy, so setup kept it and `brew upgrade` never reached the daemon. Setup now adopts Homebrew's binary, and `doctor` warns when the two have drifted. Run `bouncer setup` once to fix an existing install.
- Menu bar app: with every toolchain installed (seven slots) the slot row truncated to "do…"; slots now sit in a grid and swap/disk get their own line. Session folder names get the free width instead of "Pro…esign".
- The menu bar cask is now `bouncer-app`: sharing the formula's name made `brew upgrade bouncer` warn and guess. The tap's `cask_renames.json` moves existing installs across.
- `doctor` showed the Codex "/hooks" instruction with a ✓; it's now a note.

## [0.5.0] - 2026-11-02

Setup that fits the machine and the agents on it.

### Added
- **Guided setup** (`bouncer install`, rerun with `bouncer setup`): scans the Mac, asks which agents to connect and how many sessions you run, shows the plan and every file it will touch, then installs. Esc changes nothing. `--yes` for scripts.
- **Tuning per machine**: heavy-job limits from RAM and performance cores, minus the measured cost of your agent sessions. `bouncer tune [--apply]` compares and adopts; `doctor` flags a policy that doesn't fit.
- **Codex**: hooks for "prioritize this" and guardrails, plus a note in `AGENTS.md` (respects `CODEX_HOME` and `AGENTS.override.md`). **Gemini CLI**: a note in `GEMINI.md`. Grok, Cursor Agent, OpenCode, Amp and Aider are detected and queued by the shims.
- Priority by project folder: "prioritize this" raises every build in that project, whichever process started it.
- `install.sh` refuses macOS older than 13 before downloading, and gives the wizard the keyboard under `curl | sh`.

### Fixed (from an independent review)
- Editing a symlinked config (stow, chezmoi, yadm) replaced the link with a plain file and could loosen 0600 permissions; links and permissions are now kept.
- `dotnet run`/`watch`, `dotnet app.dll` and other `run` commands held a slot until stopped; servers are no longer gated (their memory still counts).
- A broken `policy.yaml` could crash-loop the daemon and leave builds unguarded; it now runs on defaults and reports the error.
- Agents could skip the queue with any `BOUNCER_*` variable or inside `bash -c '…'`; both are refused now.
- Uninstall now finds every Claude profile it edited, both Codex instruction files, and still works after `brew uninstall` (`~/.bouncer/bouncer` is a copy that follows Homebrew upgrades).
- `clean --apply` refuses to run without the daemon, skips git submodules, and protects folders with live work above or inside them.
- A differently spelled PATH entry could make a shim exec itself forever.
- Migrations, publishes and installs are never preempted or reaped; "prioritize" now needs "this/it/that…" (a pasted text containing the word triggered it); a job that finished before a preempt landed isn't rerun. `bouncer run --restartable` opts a script in.
- Tests could edit the real `~/.claude` and `~/.codex`: Bun caches `os.homedir()`, so setting `HOME` in a test didn't isolate it. All home lookups now read `HOME` live, and the test suite runs in a throwaway home it verifies before starting.
- Backups made within the same second no longer overwrite each other.
- Terminal wrapper scripts (cmux's) no longer count as installed agents.

## [0.4.0] - 2026-11-02

Ready for Homebrew.

### Added
- Homebrew formula (CLI + daemon) and cask (menu bar app), generated from each release's checksums and pushed to `griphaugland/homebrew-tap` by the release workflow.
- Upgrades apply on their own: the daemon restarts onto a new binary as soon as no build is running. Homebrew installs link to the version-independent `opt` path.
- `NO_COLOR` / `FORCE_COLOR` support; one visual language across `status`, `doctor`, `clean`, `install` and the menu bar.
- Menu bar: the icon is a dial (it read as a loading spinner), a native footer, a "not set up" view with a copyable install command.
- `scripts/e2e-fresh-install.sh` (zsh and bash) and `scripts/e2e-homebrew.sh`: install as a brand-new user, use, uninstall, verify nothing is left. The fresh-install test runs in CI.

### Fixed
- On a new Mac account there is no `~/.zshrc`, so the PATH line was never written and nothing was gated. The login shell's startup file is now created (`~/.bash_profile` for bash, which is what macOS login shells read).
- `bouncer install` exits non-zero when the daemon doesn't start.
- The agent guard only reacts to commands that actually run `bouncer`; text that merely mentions them (heredocs, quoted strings) no longer trips it.
- `bouncer clean` no longer counts the whole pnpm store as reclaimable.
- During a daemon restart, clients retry for 2 s instead of running a build unguarded.
- A test or custom-home install gets its own launchd job and never replaces the real daemon.
- Release binaries carry a real code-signing identifier (`com.bouncer.cli`).

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
