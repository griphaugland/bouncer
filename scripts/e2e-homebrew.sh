#!/bin/sh
# Homebrew path end to end: after `brew install` of the formula, run `bouncer install` as a fresh
# user, check it links to Homebrew's stable opt path, simulate `brew upgrade`, and check the
# daemon restarts onto the new binary. Then uninstall. Runs in a throwaway $HOME with its own
# launchd label, so it never touches a real Bouncer install.
#
#   scripts/e2e-homebrew.sh            (needs `brew install <tap>/bouncer` done first)
set -eu

BREW_BIN="$(brew --prefix)/bin/bouncer"
OPT="$(brew --prefix)/opt/bouncer/bin/bouncer"
[ -x "$BREW_BIN" ] || { echo "bouncer is not brew-installed" >&2; exit 2; }

FAKE="$(mktemp -d /tmp/bouncer-brew.XXXXXX)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
cleanup() {
  [ -e "$FAKE/.bouncer/bouncer" ] && HOME="$FAKE" "$FAKE/.bouncer/bouncer" uninstall --purge >/dev/null 2>&1 || true
  rm -rf "$FAKE"
}
trap cleanup EXIT INT TERM

export HOME="$FAKE" SHELL=/bin/zsh
unset CLAUDE_CONFIG_DIR BOUNCER_HOME || true
mkdir -p "$HOME/.claude" && echo '{}' > "$HOME/.claude/settings.json"

"$BREW_BIN" install > "$FAKE/install.log" 2>&1 && ok "bouncer install from the Homebrew binary" || { bad "bouncer install"; cat "$FAKE/install.log"; exit 1; }
[ "$(readlink "$HOME/.bouncer/bouncer")" = "$OPT" ] && ok "~/.bouncer/bouncer links to $OPT" || bad "links to the opt path (got $(readlink "$HOME/.bouncer/bouncer" || echo 'a copy'))"

LABEL="$(ls "$HOME/Library/LaunchAgents" | sed -n 's/\.plist$//p' | head -1)"
pid() { launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^\tpid =/{print $3}'; }
BEFORE="$(pid)"
[ -n "$BEFORE" ] && ok "daemon running (pid $BEFORE)" || bad "daemon running"

# `brew upgrade` swaps the file behind the opt link; touching it changes the same stamp.
touch "$(readlink -f "$OPT")"
for _ in $(seq 1 40); do
  sleep 0.25
  AFTER="$(pid)"
  [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && break
done
[ -n "${AFTER:-}" ] && [ "$AFTER" != "$BEFORE" ] && ok "daemon restarted onto the upgraded binary (pid $AFTER)" || bad "daemon restarted after upgrade"
grep -q "binary was upgraded" "$HOME/.bouncer/daemon.log" && ok "restart logged" || bad "restart logged"
# A heavy command right after the restart must still be gated, not fail open.
"$HOME/.bouncer/bouncer" run --slot e2e -- true 2> "$FAKE/run.err" && ! grep -q unguarded "$FAKE/run.err" \
  && ok "a job straight after the restart is gated (no fail-open window)" || bad "job after restart gated"
"$HOME/.bouncer/bouncer" status --json | grep -q '"version"' && ok "new daemon answers" || bad "new daemon answers"

"$HOME/.bouncer/bouncer" uninstall --purge > /dev/null 2>&1 && ok "uninstall" || bad "uninstall"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && bad "launchd job removed" || ok "launchd job removed"

echo
[ "$FAIL" -eq 0 ] && printf '\033[32mall %s checks passed\033[0m\n' "$PASS" || { printf '\033[31m%s failed\033[0m\n' "$FAIL"; exit 1; }
