import {
  ForgeReadError,
  type Clock,
  type ForgeInstallation,
  type InstallationReader,
} from "@rocky-reviews/core";
import { z } from "zod";
import { githubAppJwt, type GitHubAppAuth } from "./app-auth.js";
import { isAbort, readCapped } from "./http.js";

/**
 * `GET /app/installations/{installation_id}` as the app (P3-3, ADR 0009): the re-verification
 * every installation event goes through before the worker acts on it (ADR 0007 §4). A webhook
 * row is a hint; this is the fact.
 *
 * - 200 → the installation, its account (id, login, kind) and whether it is suspended;
 * - 404 → `null`: GitHub positively says it does not exist (for this app);
 * - anything else (401, 403, 5xx, a redirect, a timeout, an oversized or malformed body, an id
 *   that is not the one asked for) → `ForgeReadError`. Never `null`: an outage must not look like
 *   an uninstall.
 *
 * One request to the configured API base only: https (checked by `githubEndpoints`), no
 * redirects followed, 10 s timeout, 256 KiB cap.
 */

export const INSTALLATION_READ_TIMEOUT_MS = 10_000;
export const MAX_INSTALLATION_RESPONSE_BYTES = 256 * 1024;

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);

/** Only the fields used; everything else in the response (URLs, permissions, …) is dropped. */
const InstallationResponse = z.object({
  id: ForgeId,
  app_id: ForgeId.optional(),
  account: z.object({ id: ForgeId, login: Login, type: z.string().max(64) }),
  suspended_at: z.string().max(64).nullable().optional(),
});

const ACCOUNT_KIND: Readonly<Record<string, "organization" | "user">> = {
  Organization: "organization",
  User: "user",
};

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export interface GitHubInstallationReaderOptions {
  readonly auth: GitHubAppAuth;
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export const createGitHubInstallationReader = (
  options: GitHubInstallationReaderOptions,
): InstallationReader => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  const doFetch = options.fetch ?? fetch;

  const getInstallation = async (installationId: number): Promise<ForgeInstallation | null> => {
    if (!isId(installationId)) throw new Error("getInstallation: invalid installation id");
    const url = new URL(`app/installations/${installationId}`, options.api);
    const signal = AbortSignal.timeout(options.timeoutMs ?? INSTALLATION_READ_TIMEOUT_MS);

    let bytes: Buffer | undefined;
    try {
      const response = await doFetch(url.href, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${githubAppJwt(options.auth, options.clock.now())}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "rocky-reviews",
        },
        redirect: "error",
        signal,
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new ForgeReadError("http_status", response.status);
      }
      const type = response.headers.get("content-type") ?? "";
      if (!/^application\/(?:vnd\.github\+)?json\b/i.test(type)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ForgeReadError("invalid_response");
      }
      bytes = await readCapped(response, MAX_INSTALLATION_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ForgeReadError) throw error;
      if (signal.aborted || isAbort(error)) throw new ForgeReadError("timeout");
      throw new ForgeReadError("network");
    }
    if (bytes === undefined) throw new ForgeReadError("invalid_response");

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ForgeReadError("invalid_response");
    }
    const parsed = InstallationResponse.safeParse(json);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    const r = parsed.data;
    // The answer must be about what was asked, for this app.
    if (r.id !== installationId) throw new ForgeReadError("invalid_response");
    if (r.app_id !== undefined && r.app_id !== options.auth.appId) {
      throw new ForgeReadError("invalid_response");
    }
    const kind = Object.hasOwn(ACCOUNT_KIND, r.account.type)
      ? ACCOUNT_KIND[r.account.type]
      : undefined;
    if (kind === undefined) throw new ForgeReadError("unsupported_account_type");
    return {
      id: r.id,
      account: { id: r.account.id, login: r.account.login, kind },
      suspended: r.suspended_at !== null && r.suspended_at !== undefined,
    };
  };

  return { kind: "github", getInstallation };
};
