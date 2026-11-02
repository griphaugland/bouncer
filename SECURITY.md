# Security

Bouncer runs as you, on your machine, and sits in the path of every build. These are the
guarantees it makes and how they are enforced.

| Guarantee | How |
|---|---|
| Other local users cannot talk to the daemon | `~/.bouncer` is `0700`, the socket `0600`. The daemon re-applies this on every start; `bouncer doctor` checks it. |
| Secrets in command lines don't land on disk in the clear | Command lines are redacted before they reach the log, history, `status` or notifications: secret-named env assignments, `--password`/`--token` style flags, URL credentials, and known token shapes (`ghp_`, `sk-`, `AKIA`, …). |
| Scheduled jobs don't persist your environment | Only `PATH HOME USER SHELL LANG LC_ALL TERM` and session ids are stored, never tokens. The scheduled command itself is stored as given (it has to run), in the owner-only database. |
| Your project's `.env` never leaks into builds | The binary is compiled without `.env`/`bunfig.toml` autoloading (a regression test runs it in a folder with a `.env`). |
| Agents can't jump the queue or switch Bouncer off | Bouncer's Claude Code hook refuses agent commands that use `BOUNCER_BYPASS`, `bouncer prioritize/cancel/unschedule/uninstall`, `bouncer clean --apply`, or `launchctl` on the daemon. Codex has no equivalent hook yet, so this holds for Claude Code only. |
| Bouncer never deletes your work | `bouncer clean` is a dry run unless you pass `--apply` and name categories. Build output is deleted only in worktrees idle 14+ days, only where `git check-ignore` confirms it is ignored, never where an agent session is working. Whole worktrees and untracked folders are only reported. |
| A broken Bouncer never blocks you | Every failure path fails open: no daemon, a crashed daemon's stale socket, an invalid policy file, a hook error. |
| No network | The daemon and CLI make no network calls. Only `install.sh` downloads, and it verifies SHA-256 checksums before running anything. |

Release binaries are built in GitHub Actions from a tagged commit, with actions pinned to commit
SHAs. When the maintainer's Developer ID secrets are configured they are signed and notarized;
otherwise they are ad-hoc signed.

## Reporting a vulnerability

Please report privately via GitHub's **Security → Report a vulnerability** on this repository,
not in a public issue. Include `bouncer --version` and `bouncer doctor` output. You will get a
reply within a few days.
