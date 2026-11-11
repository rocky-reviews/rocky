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
 * - 404 with GitHub's own JSON `{"message": "Not Found"}` → `null`: GitHub positively says it
 *   does not exist (for this app). Any other 404 (a proxy's HTML page, an empty body, another
 *   message) is `invalid_response` (review round 1, M2);
 * - anything else (401, 403, 5xx, a redirect, a timeout, an oversized or malformed body, an id
 *   that is not the one asked for) → `ForgeReadError`. Never `null`: an outage must not look like
 *   an uninstall.
 *
 * `GET /app` (`verifyApp`) proves the key belongs to the configured app id: GitHub answers 404
 * for another app's installations, so a key for the wrong app would make every installation
 * look uninstalled (review round 1, M2).
 *
 * `GET /app/installations` (`listInstallations`, P10-2): the app's first installations, for the
 * setup wizard's "first repository" step. Entries the domain does not model (enterprise accounts)
 * are left out; a malformed entry fails the whole answer.
 *
 * One request to the configured API base only: https (checked by `githubEndpoints`), no
 * redirects followed, 10 s timeout, 256 KiB cap.
 */

export const INSTALLATION_READ_TIMEOUT_MS = 10_000;
export const MAX_INSTALLATION_RESPONSE_BYTES = 256 * 1024;

const ForgeId = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);

/** Only the fields used; everything else in the response (URLs, permissions, …) is dropped. */
const InstallationEnvelope = z.object({
  id: ForgeId,
  app_id: ForgeId.optional(),
  target_type: z.string().max(64).optional(),
  account: z.record(z.string(), z.unknown()),
  suspended_at: z.string().max(64).nullable().optional(),
});
const UserOrOrganization = z.object({ id: ForgeId, login: Login, type: z.string().max(64) });
/** GitHub's enterprise account: `slug` and `name`, no `login` or `type`. */
const Enterprise = z.object({ id: ForgeId, slug: z.string().min(1).max(255) });
const NotFound = z.object({ message: z.literal("Not Found") });
const App = z.object({ id: ForgeId, slug: z.unknown().optional() });
/** GitHub app slugs: what `https://github.com/apps/<slug>` takes. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const ACCOUNT_KIND: Readonly<Record<string, "organization" | "user">> = {
  Organization: "organization",
  User: "user",
};

const JSON_TYPE = /^application\/(?:vnd\.github\+)?json\b/i;

/** Installations the setup wizard lists (one page; a fresh install has one or two). */
export const SETUP_INSTALLATIONS_PAGE = 20;

export interface GitHubInstallationReader extends InstallationReader {
  /** The app's first `SETUP_INSTALLATIONS_PAGE` installations (P10-2). */
  listInstallations(): Promise<ForgeInstallation[]>;
  /**
   * `verifyApp`, and the app's slug for its install link (P10-2); `null` when GitHub returned
   * none that is usable in a URL.
   */
  appSlug(): Promise<string | null>;
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export interface GitHubInstallationReaderOptions {
  readonly auth: GitHubAppAuth;
  /** API base from `githubEndpoints` (https, ends with `/`). */
  readonly api: URL;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const decodeJson = (bytes: Buffer): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ForgeReadError("invalid_response");
  }
};

export const createGitHubInstallationReader = (
  options: GitHubInstallationReaderOptions,
): GitHubInstallationReader => {
  if (options.api.protocol !== "https:") throw new Error("GitHub API base must be https");
  const doFetch = options.fetch ?? fetch;

  /**
   * One GET as the app. Returns the status and the parsed JSON body for 200 and 404 (both
   * required to be JSON within the cap); throws `ForgeReadError` for everything else.
   */
  const getAsApp = async (path: string): Promise<{ status: 200 | 404; json: unknown }> => {
    const url = new URL(path, options.api);
    const signal = AbortSignal.timeout(options.timeoutMs ?? INSTALLATION_READ_TIMEOUT_MS);
    let status: 200 | 404;
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
      if (response.status !== 200 && response.status !== 404) {
        await response.body?.cancel().catch(() => undefined);
        throw new ForgeReadError("http_status", response.status);
      }
      status = response.status;
      if (!JSON_TYPE.test(response.headers.get("content-type") ?? "")) {
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
    return { status, json: decodeJson(bytes) };
  };

  /**
   * One installation object, for this app (and with `expectedId`, the one asked for); throws
   * `ForgeReadError` when it is not usable.
   */
  const toInstallation = (json: unknown, expectedId?: number): ForgeInstallation => {
    const parsed = InstallationEnvelope.safeParse(json);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    const r = parsed.data;
    // The answer must be about what was asked, for this app.
    if (expectedId !== undefined && r.id !== expectedId) {
      throw new ForgeReadError("invalid_response");
    }
    if (r.app_id !== undefined && r.app_id !== options.auth.appId) {
      throw new ForgeReadError("invalid_response");
    }
    const account = UserOrOrganization.safeParse(r.account);
    if (!account.success) {
      // An enterprise installation exists; the domain just does not model it (review N2).
      const enterprise = r.target_type === "Enterprise" || Enterprise.safeParse(r.account).success;
      if (enterprise && r.account["login"] === undefined) {
        throw new ForgeReadError("unsupported_account_type");
      }
      throw new ForgeReadError("invalid_response");
    }
    const kind = Object.hasOwn(ACCOUNT_KIND, account.data.type)
      ? ACCOUNT_KIND[account.data.type]
      : undefined;
    if (kind === undefined) throw new ForgeReadError("unsupported_account_type");
    return {
      id: r.id,
      account: { id: account.data.id, login: account.data.login, kind },
      suspended: r.suspended_at !== null && r.suspended_at !== undefined,
    };
  };

  const getInstallation = async (installationId: number): Promise<ForgeInstallation | null> => {
    if (!isId(installationId)) throw new Error("getInstallation: invalid installation id");
    const { status, json } = await getAsApp(`app/installations/${installationId}`);
    if (status === 404) {
      if (!NotFound.safeParse(json).success) throw new ForgeReadError("invalid_response");
      return null;
    }
    return toInstallation(json, installationId);
  };

  const readApp = async (): Promise<z.infer<typeof App>> => {
    const { status, json } = await getAsApp("app");
    // GET /app has no "not found" meaning: the JWT authenticates some app or GitHub says 401.
    if (status === 404) throw new ForgeReadError("http_status", 404);
    const parsed = App.safeParse(json);
    if (!parsed.success) throw new ForgeReadError("invalid_response");
    if (parsed.data.id !== options.auth.appId) throw new ForgeReadError("app_mismatch");
    return parsed.data;
  };

  const verifyApp = async (): Promise<void> => {
    await readApp();
  };

  const appSlug = async (): Promise<string | null> => {
    const { slug } = await readApp();
    return typeof slug === "string" && SLUG.test(slug) ? slug : null;
  };

  const listInstallations = async (): Promise<ForgeInstallation[]> => {
    const { status, json } = await getAsApp(
      `app/installations?per_page=${SETUP_INSTALLATIONS_PAGE}`,
    );
    if (status === 404 || !Array.isArray(json)) throw new ForgeReadError("invalid_response");
    const installations: ForgeInstallation[] = [];
    for (const entry of json.slice(0, SETUP_INSTALLATIONS_PAGE)) {
      try {
        installations.push(toInstallation(entry));
      } catch (error) {
        // An enterprise installation exists; the domain just does not model it (review N2).
        if (error instanceof ForgeReadError && error.reason === "unsupported_account_type")
          continue;
        throw error;
      }
    }
    return installations;
  };

  return { kind: "github", getInstallation, verifyApp, listInstallations, appSlug };
};
