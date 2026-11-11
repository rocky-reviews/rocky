import { z } from "zod";

/**
 * The setup wizard's API (P10-2, ADR 0044): what `GET /api/setup/status` and
 * `POST /api/setup/llm-test` answer. The server builds these from fixed codes, counts, provider
 * and model names, and GitHub's own names (account logins, repository names), which the page
 * renders as text. Nothing secret: no key, no token, no credential, no prompt or model output.
 * Both sides validate against these schemas.
 */

const Code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
/** `owner/name` or a login as GitHub returns it; shown as text, never as markup. */
const ForgeName = z.string().min(1).max(200);

export const SETUP_DATABASE_STATES = [
  "ok",
  "unreachable",
  "login_refused",
  "extension_missing",
  "migrations_pending",
] as const;

export const SETUP_GITHUB_APP_STATES = [
  /** No app yet: create one from the manifest. */
  "not_created",
  /** The credentials file was written; Rocky has not been restarted with its values. */
  "created",
  /** `GITHUB_APP_ID` is set and GitHub accepts the app's key. */
  "configured",
  /** `GITHUB_APP_ID` is set but the check with GitHub failed (`error` says how). */
  "check_failed",
] as const;

export const SETUP_LLM_STATES = ["not_tested", "ok", "failed", "invalid_config"] as const;

export const SETUP_REPOSITORY_STATES = [
  /** The app is not configured yet. */
  "waiting_for_app",
  /** The app is installed nowhere. */
  "not_installed",
  /** Installed; no analysis has finished yet. */
  "installed",
  /** At least one analysis finished. */
  "analysed",
  "check_failed",
] as const;

export const SetupProbeResult = z.strictObject({
  roles: z
    .array(z.enum(["triage", "review", "graph", "ask", "embed"]))
    .min(1)
    .max(5),
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  model: z.string().min(1).max(200),
  outcome: Code,
  durationMs: Count,
});
export type SetupProbeResult = z.infer<typeof SetupProbeResult>;

export const SetupProbeResponse = z.strictObject({
  results: z.array(SetupProbeResult).max(5),
});
export type SetupProbeResponse = z.infer<typeof SetupProbeResponse>;

const AnalysisCounts = z.strictObject({
  queued: Count,
  running: Count,
  awaitingApproval: Count,
  done: Count,
  failed: Count,
});

export const SetupInstallation = z.strictObject({
  account: ForgeName,
  kind: z.enum(["organization", "user"]),
  suspended: z.boolean(),
  /** Rocky has the org (the worker processed the installation event). */
  ready: z.boolean(),
  repositories: Count,
  pullRequests: Count,
  analyses: AnalysisCounts,
  latestDone: z.strictObject({ fullName: ForgeName, number: z.int().min(1) }).nullable(),
});
export type SetupInstallation = z.infer<typeof SetupInstallation>;

export const SetupStatusResponse = z.strictObject({
  /** `setup`: the server runs the wizard only (production, before the app is configured). */
  mode: z.enum(["setup", "full"]),
  /** The synchronizer token the wizard's POSTs carry in `x-rocky-csrf`. */
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  database: z.strictObject({
    state: z.enum(SETUP_DATABASE_STATES),
    /** Missing extensions, schema names (`table` or `table.column`) or refusal codes. */
    details: z.array(z.string().max(128)).max(20),
  }),
  githubApp: z.strictObject({
    state: z.enum(SETUP_GITHUB_APP_STATES),
    error: Code.nullable(),
    /** The manifest flow's page, while an app can be created here. */
    createPath: z.literal("/setup/github-app").nullable(),
    /** Why an app cannot be created here yet (`webhook_url_missing`). */
    createBlocked: Code.nullable(),
    /** Where the credentials were (or will be) written: shown so the operator can find them. */
    credentialsFile: z.string().max(4096),
    /** GitHub's page to install the app on repositories (https). */
    installUrl: z.url({ protocol: /^https$/ }).nullable(),
  }),
  llm: z.strictObject({
    state: z.enum(SETUP_LLM_STATES),
    /** The configuration's problems (variable paths and rules, never values of keys). */
    configError: z.string().max(2000).nullable(),
    targets: z
      .array(
        z.strictObject({
          roles: SetupProbeResult.shape.roles,
          provider: SetupProbeResult.shape.provider,
          model: SetupProbeResult.shape.model,
        }),
      )
      .max(5),
    results: z.array(SetupProbeResult).max(5).nullable(),
  }),
  repositories: z.strictObject({
    state: z.enum(SETUP_REPOSITORY_STATES),
    error: Code.nullable(),
    installations: z.array(SetupInstallation).max(20),
  }),
});
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;
