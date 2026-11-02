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
])("agents may not: %s", (cmd) => expect(humanOnlyReason(cmd)).toContain("reserved for the user"));

test.each(["bouncer status", "bouncer clean", "bouncer schedule --in 30m -- pnpm test", "dotnet test", "git log"])(
  "agents may: %s",
  (cmd) => expect(humanOnlyReason(cmd)).toBeNull(),
);
