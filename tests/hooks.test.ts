import { expect, test } from "bun:test";
import { humanOnlyReason } from "../src/hooks";

test.each([
  "BOUNCER_BYPASS=1 dotnet test",
  "cd api && BOUNCER_BYPASS=1 pnpm build",
  "bouncer prioritize 12",
  "~/.bouncer/bouncer cancel 7",
  "bouncer uninstall --purge",
  "bouncer clean --apply all",
  "launchctl bootout gui/501/com.bouncer.daemon",
  "export BOUNCER_BYPASS=1; dotnet test",
  "time env BOUNCER_BYPASS=1 pnpm build",
])("agents may not: %s", (cmd) => expect(humanOnlyReason(cmd)).toContain("reserved for the user"));

test.each([
  "bouncer status",
  "bouncer clean",
  "bouncer schedule --in 30m -- pnpm test",
  "dotnet test",
  "git log",
  // Mentions are not invocations (found 2026-11-02: the guard blocked an edit script that
  // contained the text of these commands).
  "cat > README.md <<'EOF'\nbouncer clean --apply pnpm-store\nBOUNCER_BYPASS=1 dotnet test\nbouncer cancel 3\nEOF",
  "python3 - <<EOF\ns.replace('bouncer clean --apply', 'x')\nEOF",
  "grep -n 'bouncer prioritize' README.md",
  'echo "use BOUNCER_BYPASS=1 to skip"',
  "git commit -m 'document bouncer uninstall'",
])("agents may: %s", (cmd) => expect(humanOnlyReason(cmd)).toBeNull());
