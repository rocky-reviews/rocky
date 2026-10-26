import { createPrivateKey } from "node:crypto";
import { z } from "zod";
import { isAbort, readCapped } from "./http.js";
import { checkWebhookSecret } from "./signature.js";

/**
 * GitHub App manifest flow (P3-1, ADR 0008): the manifest Rocky asks GitHub to create, and the
 * one call that turns the temporary code into the app's credentials
 * (`POST /app-manifests/{code}/conversions`). GitHub specifics only; the setup routes live in
 * `apps/server`. The permissions and events are pinned by `app-manifest.test.ts`: widening them
 * is an ADR change, not a code tweak.
 */

/** What the app may do, and nothing more (ADR 0008 justifies each). */
export const GITHUB_APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  contents: "read",
  pull_requests: "write",
  checks: "read",
  metadata: "read",
});

/**
 * Subscribed webhook events. `installation` is delivered to every app without subscribing; the
 * receiver (P3-2) decodes only `installation`, `pull_request` and `ping`.
 */
export const GITHUB_APP_EVENTS: readonly string[] = Object.freeze(["pull_request"]);

const DESCRIPTION =
  "Rocky Reviews (self-hosted): AI does the reading, a human makes the call. Only a person posts reviews.";

/** Route paths the manifest points at (the server registers the first; P7-1 the second). */
export const SETUP_CALLBACK_PATH = "/setup/github-app/callback";
export const OAUTH_CALLBACK_PATH = "/auth/github/callback";

/** GitHub limits app names to 34 characters; we also keep them to a plain, HTML-safe set. */
const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,33}$/;
/** GitHub user and organization logins (39 characters, alphanumerics and inner hyphens). */
const ORG_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** States Rocky issues: 32 random bytes, base64url. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** Manifest codes GitHub returns are short hex strings; anything else never reaches a URL. */
const MANIFEST_CODE = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * Characters inert in a `.env` file and in a POSIX shell, quoted or not: no whitespace, quotes,
 * `$`, `#`, backslash, backtick, `!`, `*`, `?`, `;`, `^`, `,`. Shared with the credentials writer.
 */
export const ENV_SAFE = /^[A-Za-z0-9._~+/=:@%-]+$/;
/** App slugs: lower-case letters, digits, `-` and `_`. */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

export interface GitHubAppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  public: false;
  default_events: string[];
  default_permissions: Record<string, string>;
  request_oauth_on_install: false;
  setup_on_update: false;
}

export interface ManifestOptions {
  /** 1–34 characters; the person creating the app can still edit it on GitHub. */
  name: string;
  /** Where Rocky is served (validated by the caller: https, or http on loopback). */
  publicUrl: URL;
  /** Receives webhooks: must be https (GitHub must reach it). */
  webhookUrl: URL;
  /** The app's homepage on GitHub; defaults to `publicUrl` (GITHUB_APP_HOMEPAGE_URL). */
  homepageUrl?: URL;
}

const at = (base: URL, path: string): string => new URL(path, base).href;

/** The manifest, built only from validated configuration. Key order is fixed. */
export const buildGitHubAppManifest = (options: ManifestOptions): GitHubAppManifest => {
  if (!APP_NAME.test(options.name)) {
    throw new Error("the app name must be 1-34 letters, digits, spaces or ._()-");
  }
  if (options.webhookUrl.protocol !== "https:") {
    throw new Error("the webhook URL must be https");
  }
  return {
    name: options.name,
    url: (options.homepageUrl ?? options.publicUrl).href,
    description: DESCRIPTION,
    hook_attributes: { url: options.webhookUrl.href, active: true },
    redirect_url: at(options.publicUrl, SETUP_CALLBACK_PATH),
    callback_urls: [at(options.publicUrl, OAUTH_CALLBACK_PATH)],
    public: false,
    default_events: [...GITHUB_APP_EVENTS],
    default_permissions: { ...GITHUB_APP_PERMISSIONS },
    request_oauth_on_install: false,
    setup_on_update: false,
  };
};

export interface GitHubEndpoints {
  /** github.com or the GHES host: where the manifest form is posted. */
  readonly web: URL;
  /** api.github.com or `<GHES>/api/v3/`: where the code is converted. Ends with `/`. */
  readonly api: URL;
}

const httpsBase = (raw: string, what: string, paths: readonly string[]): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${what} must be https`);
  if (url.username !== "" || url.password !== "")
    throw new Error(`${what} must not carry credentials`);
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new Error(`${what} must not have a query or fragment`);
  }
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  if (!paths.includes(path)) throw new Error(`${what} has an unexpected path`);
  return new URL(path, url.origin);
};

/** GitHub (default) or GitHub Enterprise Server endpoints; https only, no paths beyond the API base. */
export const githubEndpoints = (options: { webUrl?: string; apiUrl?: string }): GitHubEndpoints => {
  const web = httpsBase(options.webUrl ?? "https://github.com", "the GitHub URL", ["/"]);
  const defaultApi = web.host === "github.com" ? "https://api.github.com" : `${web.origin}/api/v3`;
  const api = httpsBase(options.apiUrl ?? defaultApi, "the GitHub API URL", ["/", "/api/v3/"]);
  return { web, api };
};

/** `…/settings/apps/new?state=…`, or the organization's form when `org` is given. */
export const manifestFormAction = (
  endpoints: GitHubEndpoints,
  state: string,
  org?: string,
): string => {
  if (!STATE.test(state)) throw new Error("malformed state");
  if (org !== undefined && !ORG_LOGIN.test(org)) throw new Error("malformed organization login");
  const path = org === undefined ? "settings/apps/new" : `organizations/${org}/settings/apps/new`;
  const url = new URL(path, endpoints.web);
  url.searchParams.set("state", state);
  return url.href;
};

export const isOrganizationLogin = (value: unknown): value is string =>
  typeof value === "string" && ORG_LOGIN.test(value);

export const isManifestCode = (value: unknown): value is string =>
  typeof value === "string" && MANIFEST_CODE.test(value);

/**
 * GitHub's secret when it is safe to use as Rocky's webhook secret: long enough for
 * `checkWebhookSecret` and only characters that are inert in an env file and in a shell
 * (`ENV_SAFE`). `undefined` → the caller generates one and tells the human to set it.
 */
export const usableWebhookSecret = (secret: string | null): string | undefined => {
  if (secret === null || !ENV_SAFE.test(secret)) return undefined;
  try {
    return checkWebhookSecret(secret);
  } catch {
    return undefined;
  }
};

export type ManifestConversionFailure =
  "invalid_code" | "timeout" | "network" | "http_status" | "invalid_response";

/** Fixed message per reason; carries at most GitHub's HTTP status, never a body or value. */
export class ManifestConversionError extends Error {
  override readonly name = "ManifestConversionError";
  constructor(
    readonly reason: ManifestConversionFailure,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `manifest conversion failed: ${reason}`
        : `manifest conversion failed: ${reason} ${status}`,
    );
  }
}

/** Long enough for GitHub, well inside the hour the code lives. */
export const MANIFEST_CONVERSION_TIMEOUT_MS = 10_000;
/** A conversion response is a few KiB; anything bigger is refused unread. */
export const MAX_CONVERSION_RESPONSE_BYTES = 256 * 1024;

const PEM =
  /^-----BEGIN (RSA )?PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END \1PRIVATE KEY-----\n?$/;

const PrivateKeyPem = z
  .string()
  .max(16 * 1024)
  .regex(PEM)
  .refine((pem) => {
    try {
      const key = createPrivateKey(pem);
      return (
        key.asymmetricKeyType === "rsa" && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
      );
    } catch {
      return false;
    }
  });

/**
 * The fields Rocky keeps from the conversion, each shape-checked: every value lands in an env
 * file, so nothing may carry a newline, quote or shell metacharacter. Unknown fields are dropped.
 */
const ConversionResponse = z.object({
  id: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  // Optional in GitHub's schema; checked separately so a missing or odd slug never loses the
  // credentials (`slugOf`).
  slug: z.unknown().optional(),
  html_url: z.unknown().optional(),
  client_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  client_secret: z.string().regex(/^[A-Za-z0-9._-]{20,255}$/),
  webhook_secret: z.string().max(1024).nullable(),
  pem: PrivateKeyPem,
  permissions: z.record(z.string().max(100), z.string().max(20)),
  events: z.array(z.string().max(100)).max(200),
});

export interface GitHubAppCredentials {
  appId: number;
  /** Undefined when GitHub returned no usable slug (callers then omit it and the install link). */
  slug: string | undefined;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  /** As returned; check it with `usableWebhookSecret` before use. */
  webhookSecret: string | null;
  permissions: Record<string, string>;
  events: string[];
}

/** The slug, or the last path segment of `html_url` (`https://…/apps/<slug>`), when valid. */
const slugOf = (slug: unknown, htmlUrl: unknown): string | undefined => {
  if (typeof slug === "string" && SLUG.test(slug)) return slug;
  if (typeof htmlUrl !== "string") return undefined;
  try {
    const url = new URL(htmlUrl);
    const match = /^\/apps\/([^/]+)\/?$/.exec(url.pathname);
    return url.protocol === "https:" && match?.[1] !== undefined && SLUG.test(match[1])
      ? match[1]
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Exchanges a manifest code for the app's credentials. One request to the configured API base
 * only (no redirects followed), bounded in time and size, schema-validated. Every failure is a
 * `ManifestConversionError` with a fixed reason and at most the HTTP status.
 */
export const convertManifestCode = async (options: {
  api: URL;
  code: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<GitHubAppCredentials> => {
  if (!isManifestCode(options.code)) throw new ManifestConversionError("invalid_code");
  const url = new URL(`app-manifests/${encodeURIComponent(options.code)}/conversions`, options.api);
  const signal = AbortSignal.timeout(options.timeoutMs ?? MANIFEST_CONVERSION_TIMEOUT_MS);
  const doFetch = options.fetch ?? fetch;

  let bytes: Buffer | undefined;
  try {
    const response = await doFetch(url.href, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "rocky-reviews-setup",
      },
      redirect: "error",
      signal,
    });
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined);
      throw new ManifestConversionError("http_status", response.status);
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:vnd\.github\+)?json\b/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ManifestConversionError("invalid_response");
    }
    bytes = await readCapped(response, MAX_CONVERSION_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ManifestConversionError) throw error;
    if (signal.aborted || isAbort(error)) throw new ManifestConversionError("timeout");
    throw new ManifestConversionError("network");
  }
  if (bytes === undefined) throw new ManifestConversionError("invalid_response");

  // Decoded outside the transport's try: invalid UTF-8 is a bad response, not a network error.
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ManifestConversionError("invalid_response");
  }
  const parsed = ConversionResponse.safeParse(json);
  if (!parsed.success) throw new ManifestConversionError("invalid_response");
  const r = parsed.data;
  return {
    appId: r.id,
    slug: slugOf(r.slug, r.html_url),
    clientId: r.client_id,
    clientSecret: r.client_secret,
    privateKeyPem: r.pem,
    webhookSecret: r.webhook_secret,
    permissions: { ...r.permissions },
    events: [...r.events],
  };
};

const LEVEL: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

/**
 * Grants GitHub reports beyond what the manifest requested (`permission:<name>`,
 * `event:<name>`). Empty when the app has exactly what was asked for, or less. Own keys only.
 */
export const widenedGrants = (
  permissions: Readonly<Record<string, string>>,
  events: readonly string[],
): string[] => {
  const widened: string[] = [];
  for (const [name, level] of Object.entries(permissions)) {
    const requested = Object.hasOwn(GITHUB_APP_PERMISSIONS, name)
      ? GITHUB_APP_PERMISSIONS[name]
      : undefined;
    const granted = Object.hasOwn(LEVEL, level) ? LEVEL[level] : undefined;
    if (requested === undefined || granted === undefined || granted > (LEVEL[requested] ?? 0)) {
      widened.push(`permission:${name}`);
    }
  }
  for (const event of events) {
    if (!GITHUB_APP_EVENTS.includes(event)) widened.push(`event:${event}`);
  }
  return widened;
};
