// Command lines end up in the daemon log, jobs.db and `bouncer status`. People put secrets in
// them (`GITHUB_TOKEN=ghp_… pnpm publish`, `--password hunter2`), so redact before storing.

const SECRET_NAME =
  "[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|CREDENTIALS?)[A-Za-z0-9_]*";
const ENV_ASSIGNMENT = new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|\\S+)`, "gi");
const SECRET_FLAG = /(--?(?:password|passwd|token|secret|api-?key|auth|access-?key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
// Well-known token shapes, wherever they appear.
const TOKEN_SHAPES = /\b(ghp_|gho_|ghs_|github_pat_|sk-ant-|sk-|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/g;

export function redact(command: string): string {
  return command
    .replace(ENV_ASSIGNMENT, "$1=***")
    .replace(SECRET_FLAG, "$1***")
    .replace(URL_CREDENTIALS, "$1***@")
    .replace(TOKEN_SHAPES, "$1***");
}
