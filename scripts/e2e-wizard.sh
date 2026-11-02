#!/bin/sh
# Drive the real setup wizard through a pseudo-terminal, keystroke by keystroke, in a throwaway
# HOME (own launchd label, never touches a real install). Prints the screen as the user saw it.
#
#   scripts/e2e-wizard.sh            needs dist/bouncer (bun run build)
set -eu
cd "$(dirname "$0")/.."
BIN="$(pwd)/dist/bouncer"
[ -x "$BIN" ] || { echo "build first: bun run build" >&2; exit 2; }

FAKE="$(mktemp -d /tmp/bouncer-wizard.XXXXXX)"
cleanup() {
  [ -e "$FAKE/.bouncer/bouncer" ] && HOME="$FAKE" "$FAKE/.bouncer/bouncer" uninstall --purge >/dev/null 2>&1 || true
  rm -rf "$FAKE"
}
trap cleanup EXIT INT TERM

# A user with Claude Code and Codex installed, zsh, nothing else configured.
mkdir -p "$FAKE/.claude" "$FAKE/.codex"
echo '{}' > "$FAKE/.claude/settings.json"
printf '# My Codex rules\n' > "$FAKE/.codex/AGENTS.md"

export HOME="$FAKE" SHELL=/bin/zsh TERM=xterm-256color COLUMNS=100
unset CLAUDE_CONFIG_DIR CODEX_HOME BOUNCER_HOME || true

# Keystrokes: agents (keep the detected defaults) → sessions (one down from the detected bucket)
# → extras (defaults) → Install.
/usr/bin/expect > "$FAKE/session.log" 2>&1 <<EXPECT
set timeout 30
log_user 1
spawn "$BIN" install
expect "Which agents" { send " " ; sleep 0.2 ; send " " ; sleep 0.2 ; send "\r" }
expect "How many agent sessions" { send "\033\[B" ; sleep 0.2 ; send "\r" }
expect {
  "Extras" { sleep 0.2 ; send "\r" ; exp_continue }
  "Install?" { sleep 0.2 ; send "\r" }
}
expect "on duty"
expect eof
EXPECT

# Replay the session as a terminal would show it: honour the wizard's "move up N lines and
# clear" redraws, then strip colour.
python3 - "$FAKE/session.log" <<'PY'
import re, sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read().replace("\r\n", "\n").replace("\r", "")
lines = [""]
i = 0
pat = re.compile(r"\x1b\[(\d+)A\x1b\[0J")
for m in re.finditer(r"\x1b\[(\d+)A\x1b\[0J|\x1b\[[0-9;?]*[A-Za-z]|\n|[^\x1b\n]+", raw):
    t = m.group(0)
    if pat.fullmatch(t):
        n = int(pat.fullmatch(t).group(1))
        del lines[len(lines) - 1 - n: len(lines) - 1]
        lines[-1] = ""
    elif t == "\n":
        lines.append("")
    elif t.startswith("\x1b"):
        continue
    else:
        lines[-1] += t
print("\n".join(l for l in lines if not l.startswith("spawn ")).rstrip())
PY

echo "--- checks"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; fail=1; fi; }
check "Claude Code hooks written" "grep -q 'hook pre-tool' $FAKE/.claude/settings.json"
check "Codex hooks.json written" "grep -q 'hook pre-tool --agent codex' $FAKE/.codex/hooks.json"
check "Codex AGENTS.md keeps the user's rules and gains the note" "head -1 $FAKE/.codex/AGENTS.md | grep -q 'My Codex rules' && grep -q 'bouncer:start' $FAKE/.codex/AGENTS.md"
check "policy tuned for this Mac" "grep -q 'Tuned for:' $FAKE/.bouncer/policy.yaml"
check "setup choices saved" "grep -q '\"agents\"' $FAKE/.bouncer/setup.json"
check "doctor is happy" "$FAKE/.bouncer/bouncer doctor"
HOME="$FAKE" "$FAKE/.bouncer/bouncer" uninstall --purge >/dev/null 2>&1
check "uninstall restores Codex AGENTS.md exactly" "[ \"\$(cat $FAKE/.codex/AGENTS.md)\" = '# My Codex rules' ]"
check "uninstall leaves Claude settings empty again" "[ \"\$(tr -d ' \n' < $FAKE/.claude/settings.json)\" = '{}' ]"
check "uninstall removes Codex hooks" "! grep -q bouncer $FAKE/.codex/hooks.json"

# Cancelling at the first question must leave no trace.
rm -rf "$FAKE/.bouncer"
/usr/bin/expect > "$FAKE/cancel.log" 2>&1 <<EXPECT
set timeout 30
spawn "$BIN" install
expect "Which agents" { send "\033" }
expect eof
EXPECT
check "Esc cancels with 'Nothing was changed'" "grep -q 'Nothing was changed' $FAKE/cancel.log"
check "a cancelled setup creates nothing" "[ ! -e $FAKE/.bouncer ] && ! grep -q bouncer $FAKE/.zshrc 2>/dev/null"
exit $fail
