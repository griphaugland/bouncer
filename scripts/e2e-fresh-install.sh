#!/bin/sh
# End-to-end install as a brand-new user would experience it, then a full uninstall.
#
#   scripts/e2e-fresh-install.sh [release-dir]     default: dist/release (run scripts/package.sh first)
#
# Runs in a throwaway $HOME with no shell rc files, a bare PATH and a Claude Code settings file,
# using the real release artifacts and install.sh. Its launchd job has its own label (derived
# from the fake home), so it never touches a real Bouncer install on this machine.
set -eu
cd "$(dirname "$0")/.."
RELEASE="$(cd "${1:-dist/release}" && pwd)"
[ -f "$RELEASE/SHA256SUMS" ] || { echo "no release artifacts in $RELEASE; run scripts/package.sh" >&2; exit 2; }

FAKE="$(mktemp -d /tmp/bouncer-e2e.XXXXXX)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

cleanup() {
  # Belt and braces: never leave the test daemon running, whatever failed.
  [ -x "$FAKE/.bouncer/bouncer" ] && HOME="$FAKE" "$FAKE/.bouncer/bouncer" uninstall --purge >/dev/null 2>&1 || true
  for p in "$FAKE"/Library/LaunchAgents/com.bouncer.daemon.*.plist; do
    [ -f "$p" ] && launchctl bootout "gui/$(id -u)" "$p" >/dev/null 2>&1 || true
  done
  rm -rf "$FAKE"
}
trap cleanup EXIT INT TERM

# A new account: nothing in ~, system PATH only. Claude Code installed but never configured.
# E2E_SHELL=bash tests a bash user (macOS bash login shells read ~/.bash_profile).
case "${E2E_SHELL:-zsh}" in
  zsh) LOGIN="zsh -ilc"; RC=.zshrc ;;
  bash) LOGIN="bash -lc"; RC=.bash_profile ;;
  *) echo "E2E_SHELL must be zsh or bash" >&2; exit 2 ;;
esac
export HOME="$FAKE" SHELL="/bin/${E2E_SHELL:-zsh}" PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset CLAUDE_CONFIG_DIR BOUNCER_HOME BOUNCER_BYPASS BOUNCER_JOB BOUNCER_SESSION ZDOTDIR || true
mkdir -p "$HOME/.claude" && echo '{}' > "$HOME/.claude/settings.json"

echo "fresh install into $FAKE ($SHELL)"
BOUNCER_RELEASE_DIR="$RELEASE" sh "$RELEASE/install.sh" --no-app > "$FAKE/install.log" 2>&1 \
  && ok "install.sh exits 0" || { bad "install.sh exits 0"; cat "$FAKE/install.log"; exit 1; }

B="$HOME/.bouncer/bouncer"
LABEL="$(ls "$HOME/Library/LaunchAgents" | sed -n 's/\.plist$//p' | head -1)"
check "binary installed and runs" "[ \"\$($B --version)\" = \"$(sed -n 's/.*\"version\": \"\(.*\)\".*/\1/p' package.json | head -1)\" ]"
check "~/.bouncer is private (700)" "[ \"\$(stat -f %Lp $HOME/.bouncer)\" = 700 ]"
check "launchd job uses an isolated label ($LABEL)" "[ \"$LABEL\" != com.bouncer.daemon ] && launchctl print gui/$(id -u)/$LABEL"
check "socket is private (600)" "[ \"\$(stat -f %Lp $HOME/.bouncer/bouncer.sock)\" = 600 ]"
check "~/$RC created with the PATH line" "grep -q '.bouncer/bin' $HOME/$RC"
check "Claude Code hooks written" "grep -q 'bouncer hook pre-tool' $HOME/.claude/settings.json && grep -q 'bouncer hook prompt' $HOME/.claude/settings.json"
check "statusline segment written" "grep -q 'status --segment' $HOME/.claude/settings.json"
check "a new login shell finds the shims first" "[ \"\$($LOGIN 'command -v dotnet' 2>/dev/null)\" = $HOME/.bouncer/bin/dotnet ]"
check "bouncer itself is on PATH" "$LOGIN 'bouncer --version'"
check "bouncer doctor passes" "$LOGIN 'bouncer doctor'"

# A gated job through the real daemon, from a login shell like an agent's.
check "a gated job runs through the daemon" "[ \"\$($LOGIN 'bouncer run --slot e2e -- echo gated' 2>/dev/null)\" = gated ]"
check "it is recorded in history" "$B history 5 | grep -q 'echo gated'"
check "status answers" "$B status --json | grep -q '\"version\"'"

echo "uninstall --purge"
"$B" uninstall --purge > "$FAKE/uninstall.log" 2>&1 && ok "uninstall exits 0" || { bad "uninstall exits 0"; cat "$FAKE/uninstall.log"; }
check "launchd job gone" "! launchctl print gui/$(id -u)/$LABEL"
check "plist removed" "[ ! -e $HOME/Library/LaunchAgents/$LABEL.plist ]"
check "~/.bouncer removed" "[ ! -e $HOME/.bouncer ]"
check "PATH line removed from ~/$RC" "! grep -q 'bouncer' $HOME/$RC"
check "hooks and statusline removed" "! grep -q 'bouncer' $HOME/.claude/settings.json"
check "settings.json still valid JSON" "/usr/bin/plutil -lint -s $HOME/.claude/settings.json || python3 -c 'import json,sys; json.load(open(sys.argv[1]))' $HOME/.claude/settings.json"

echo
if [ "$FAIL" -gt 0 ]; then
  printf '\033[31m%s failed\033[0m, %s passed\n' "$FAIL" "$PASS"
  echo "--- install.log"; cat "$FAKE/install.log"
  exit 1
fi
printf '\033[32mall %s checks passed\033[0m\n' "$PASS"
