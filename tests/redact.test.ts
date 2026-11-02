import { expect, test } from "bun:test";
import { redact } from "../src/redact";

test.each([
  ["GITHUB_TOKEN=ghp_abcdefghijklmnop pnpm publish", "GITHUB_TOKEN=*** pnpm publish"],
  ["NPM_AUTH_TOKEN='x y' npm publish", "NPM_AUTH_TOKEN=*** npm publish"],
  ["ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx bun run eval", "ANTHROPIC_API_KEY=*** bun run eval"],
  ["dotnet run --password hunter2 --port 5000", "dotnet run --password *** --port 5000"],
  ["psql --password=hunter2", "psql --password=***"],
  ["git clone https://eirik:hunter2@github.com/x/y", "git clone https://eirik:***@github.com/x/y"],
  ["curl -H 'Authorization: token ghp_abcdefghijklmnopqrstu'", "curl -H 'Authorization: token ghp_***'"],
  ["AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP aws s3 ls", "AWS_ACCESS_KEY_ID=*** aws s3 ls"],
])("%s", (input, expected) => expect(redact(input)).toBe(expected));

test("leaves ordinary commands alone", () => {
  for (const cmd of ["dotnet test --filter Foo", "pnpm --filter web build", "LANG=en_US.UTF-8 npx vitest run", "KEYBOARD=dk make"]) {
    expect(redact(cmd)).toBe(cmd);
  }
});
