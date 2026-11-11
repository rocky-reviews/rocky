/**
 * What the setup wizard says about each step (P10-2): fixed text per state and outcome code, so
 * nothing the server sends is ever shown as markup. Names from GitHub (logins, repository names)
 * and the provider's model names are shown as text only.
 */
import type { SetupStatusResponse } from "@rocky-reviews/core";

export type Tone = "ok" | "action" | "failed" | "waiting";

export const TONE_LABEL: Readonly<Record<Tone, string>> = {
  ok: "Done",
  action: "To do",
  failed: "Needs attention",
  waiting: "Waiting",
};

type Status = SetupStatusResponse;

export const databaseTone = (d: Status["database"]): Tone => (d.state === "ok" ? "ok" : "failed");

export const DATABASE_TEXT: Readonly<Record<Status["database"]["state"], string>> = {
  ok: "Reachable as the application login, pgvector installed, every migration applied.",
  unreachable:
    "Rocky cannot reach the database with DATABASE_URL. Check that Postgres is running and that the URL, user and password are right.",
  login_refused:
    "DATABASE_URL logs in with more rights than the server may have (the owner, a superuser, or the worker's login). Give the server its own plain application login.",
  extension_missing:
    "The pgvector extension is not installed in this database. A superuser installs it once (see the provisioning steps).",
  migrations_pending: "Some migrations have not been applied.",
};

/** What the list under the database step is (fix round: the list had no label). */
export const DATABASE_DETAILS_LABEL: Readonly<Record<Status["database"]["state"], string>> = {
  ok: "Details:",
  unreachable: "Details:",
  login_refused: "Refused because:",
  extension_missing: "Missing:",
  migrations_pending: "Missing:",
};

export const githubAppTone = (g: Status["githubApp"]): Tone =>
  g.state === "configured" || g.state === "token_connected"
    ? "ok"
    : g.state === "created"
      ? "waiting" // for the restart with the new credentials
      : g.state === "check_failed" || g.createBlocked !== null
        ? "failed"
        : "action";

export const GITHUB_APP_ERROR: Readonly<Record<string, string>> = {
  private_key_missing: "GITHUB_APP_PRIVATE_KEY is not set, so Rocky cannot act as the app.",
  app_mismatch: "The private key belongs to another GitHub App than GITHUB_APP_ID.",
  http_status: "GitHub refused the app's credentials. Check GITHUB_APP_ID and the private key.",
  network: "GitHub could not be reached from the server.",
  timeout: "GitHub did not answer in time.",
};

export const githubAppError = (code: string | null): string =>
  (code === null ? undefined : GITHUB_APP_ERROR[code]) ?? "The check with GitHub failed.";

export const llmTone = (l: Status["llm"]): Tone =>
  l.state === "ok"
    ? "ok"
    : l.state === "failed" || l.state === "invalid_config"
      ? "failed"
      : "action";

export const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  ok: "Answered",
  answered: "Answered (the reply was cut short, which is fine for this test)",
  wrong_dimensions: "Answered, but its vectors are not ROCKY_LLM_EMBED_DIMENSIONS wide",
  auth: "The provider rejected the key",
  permission: "The key may not use this model",
  billing: "The provider account has a billing problem",
  model_not_found: "This model is not available to the key",
  network: "The provider could not be reached",
  timeout: "No answer in time",
  rate_limited: "Rate-limited by the provider; try again in a minute",
  overloaded: "The provider is overloaded; try again",
  server_error: "The provider failed to answer",
  invalid_request: "The provider refused the request",
  failed: "The call failed",
};

export const outcomeText = (outcome: string): string => OUTCOME_TEXT[outcome] ?? "The call failed";
export const outcomeOk = (outcome: string): boolean => outcome === "ok" || outcome === "answered";

export const ROLE_LABEL: Readonly<Record<string, string>> = {
  triage: "triage",
  review: "review",
  graph: "change map",
  ask: "Ask",
  embed: "embeddings",
};

export const rolesLabel = (roles: readonly string[]): string =>
  roles.map((r) => ROLE_LABEL[r] ?? r).join(", ");

export const repositoriesTone = (r: Status["repositories"]): Tone =>
  r.state === "analysed"
    ? "ok"
    : r.state === "check_failed"
      ? "failed"
      : r.state === "waiting_for_app" || r.state === "waiting_for_token"
        ? "waiting"
        : "action";

export const plural = (n: number, one: string, many: string): string =>
  `${n}\u00a0${n === 1 ? one : many}`;

/** Where Rocky shows a pull request: GitHub's own path shape (`/owner/repo/pull/7`). */
export const pullPath = (fullName: string, number: number): string | null => {
  const [owner, name, ...rest] = fullName.split("/");
  if (owner === undefined || name === undefined || rest.length > 0) return null;
  const segment = /^[A-Za-z0-9._-]{1,100}$/;
  const ok = (part: string) => segment.test(part) && !/^\.+$/.test(part);
  if (!ok(owner) || !ok(name)) return null;
  return `/${owner}/${name}/pull/${number}`;
};

/** The GitHub step's title: the App, or (P10-4) one person's token. */
export const githubStepTitle = (s: Status): string =>
  s.connection === "token" ? "Connect GitHub with a personal token" : "GitHub App";

/** GitHub's page for a new fine-grained token, and the self-host guide's Plan B section. */
export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";
export const TOKEN_DOCS_URL =
  "https://github.com/rocky-reviews/rocky/blob/main/docs/self-host/setup.md#plan-b-a-personal-access-token";

/** Every step done: the person may close setup. */
export const allDone = (s: Status): boolean =>
  s.database.state === "ok" &&
  (s.githubApp.state === "configured" || s.githubApp.state === "token_connected") &&
  s.llm.state === "ok" &&
  s.repositories.state === "analysed";
