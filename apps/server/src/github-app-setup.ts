import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildGitHubAppManifest,
  convertManifestCode,
  isManifestCode,
  isOrganizationLogin,
  manifestFormAction,
  ManifestConversionError,
  usableWebhookSecret,
  widenedGrants,
  type GitHubEndpoints,
} from "@rocky-reviews/forge-github";
import rateLimit from "@fastify/rate-limit";
import { publicRoute } from "./auth/policy.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  checkCredentialsTarget,
  CredentialsFileError,
  credentialsEnvText,
  writeCredentialsOnce,
} from "./credentials-file.js";
import { pageCsp } from "./security/headers.js";

/**
 * GitHub App manifest flow for self-hosters (P3-1, ADR 0008).
 *
 *   GET /setup/github-app?token=T  one-time boot token → session cookie, 303 to the page
 *   GET /setup/github-app          (session) page with a form that POSTs the manifest to GitHub
 *   GET /setup/github-app/callback (session) `code` + `state` → one conversion → credentials file
 *
 * Registered only when explicitly requested outside production and no app is configured
 * (`githubAppSetupFromEnv`); every route answers 404 once an app has been created. Secrets from
 * the conversion go to the credentials file only: never to logs, responses or the database.
 */

export const SETUP_PATH = "/setup/github-app";
export const SETUP_CALLBACK = "/setup/github-app/callback";
export const SETUP_COOKIE = "rocky_setup";
/** A setup session lasts one hour (GitHub's manifest code also lives one hour). */
export const SETUP_SESSION_TTL_MS = 60 * 60 * 1000;
/** Time to click "Create GitHub App" on GitHub after the page was rendered. */
export const SETUP_STATE_TTL_MS = 30 * 60 * 1000;
/** Outstanding states per session; older ones are dropped. */
const MAX_STATES = 10;
/** Wrong setup tokens tolerated before token redemption locks until the server restarts. */
export const MAX_TOKEN_FAILURES = 20;
/** Requests per client per minute across the setup routes; a person needs a handful. */
export const SETUP_RATE_LIMIT_PER_MINUTE = 100;

export interface GitHubAppSetupConfig {
  publicUrl: URL;
  /** https; undefined → the page explains what to set instead of rendering a form. */
  webhookUrl: URL | undefined;
  /** The app's homepage (GITHUB_APP_HOMEPAGE_URL, https); defaults to `publicUrl`. */
  homepageUrl?: URL;
  appName: string;
  endpoints: GitHubEndpoints;
  /** Absolute path; written once with mode 0600. */
  credentialsFile: string;
}

/**
 * `Sec-Fetch-Site` values allowed to create a state: typed or pasted URLs (`none`) and Rocky's own
 * links (`same-origin`). Another site navigating the operator's browser here (the Lax cookie
 * rides along) would otherwise mint states and evict the real one (review round 1, item 5).
 * Absent (older browsers) is allowed.
 */
const STATE_FETCH_SITES = new Set(["none", "same-origin"]);

export interface GitHubAppSetupDeps extends GitHubAppSetupConfig {
  /** One-time token printed to the server's terminal at boot (never logged). */
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const randomToken = (): string => randomBytes(32).toString("base64url");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** No colours: browser defaults with `color-scheme`, so both themes work and lint stays clean. */
export const STYLE =
  ":root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}code{word-break:break-all}button{font:inherit;padding:.5rem 1rem}";
/**
 * Stricter than the app-wide headers (P7-3, ADR 0025, which add nosniff, framing, COOP and the
 * rest): only this page's style, forms only to GitHub, no referrer (the URL carries the token).
 */
const securityHeaders = (reply: FastifyReply, formOrigin: string): void => {
  void reply
    .header("content-security-policy", pageCsp({ style: STYLE, formAction: formOrigin }))
    .header("referrer-policy", "no-referrer")
    .header("cache-control", "no-store");
};

/** `body` is trusted markup built here; every dynamic value in it is passed through escapeHtml. */
const html = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;

const send = (reply: FastifyReply, status: number, title: string, body: string) =>
  reply.code(status).type("text/html; charset=utf-8").send(html(title, body));

const NOT_FOUND = { message: "Route not found", error: "Not Found", statusCode: 404 } as const;

interface Session {
  expiresAt: number;
}
interface PendingState {
  session: string;
  org: string | undefined;
  expiresAt: number;
}

/** Single-valued string query parameter; arrays (repeated params) and others → undefined. */
const param = (request: FastifyRequest, name: string): string | undefined | null => {
  const query = request.query as Record<string, unknown>;
  if (!Object.hasOwn(query, name)) return undefined;
  const value = query[name];
  return typeof value === "string" ? value : null;
};

const cookieValue = (request: FastifyRequest): string | undefined => {
  const header = request.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === SETUP_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return TOKEN_SHAPE.test(value) ? value : undefined;
    }
  }
  return undefined;
};

export const registerGitHubAppSetup = (app: FastifyInstance, deps: GitHubAppSetupDeps): void => {
  const now = deps.now ?? Date.now;
  const tokenHash = sha256(deps.token);
  let tokenUsed = false;
  let tokenFailures = 0;
  let done = false;
  let exchanging = false;
  /** Keyed by sha256(session id) hex; the cookie value is never stored. */
  const sessions = new Map<string, Session>();
  /** Keyed by sha256(state) hex. */
  const states = new Map<string, PendingState>();
  /** sha256 of every code ever presented to GitHub. */
  const usedCodes = new Set<string>();
  const formOrigin = deps.endpoints.web.origin;
  /** Where the person finds (and can delete) the app when Rocky has no direct link. */
  const appsList = (org: string | undefined): string =>
    new URL(
      org === undefined ? "settings/apps" : `organizations/${org}/settings/apps`,
      deps.endpoints.web,
    ).href;
  const link = (href: string): string => `<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`;
  const secure = deps.publicUrl.protocol === "https:";

  const prune = (): void => {
    const t = now();
    for (const [k, s] of sessions) if (s.expiresAt <= t) sessions.delete(k);
    for (const [k, s] of states) if (s.expiresAt <= t) states.delete(k);
  };

  const sessionOf = (request: FastifyRequest): string | undefined => {
    prune();
    const value = cookieValue(request);
    if (value === undefined) return undefined;
    const key = sha256(value).toString("hex");
    return sessions.has(key) ? key : undefined;
  };

  const log = (
    request: FastifyRequest,
    level: "info" | "warn" | "error",
    outcome: string,
    extra = {},
  ) => request.log[level]({ githubAppSetup: { outcome, ...extra } }, "github app setup");

  const forbidden = (reply: FastifyReply) =>
    send(
      reply,
      403,
      "Setup link required",
      "<p>Open the one-time setup URL printed in the server's terminal. If you already used it, restart the server to get a new one.</p>",
    );

  void app.register(async (scope) => {
    // Scoped to the setup routes: registered inside this encapsulated context.
    await scope.register(rateLimit, {
      max: SETUP_RATE_LIMIT_PER_MINUTE,
      timeWindow: 60_000,
    });
    scope.addHook("onRequest", async (_request, reply) => {
      securityHeaders(reply, formOrigin);
      if (done) return reply.code(404).send(NOT_FOUND);
      return undefined;
    });

    // Development only, before any org exists: guarded by the one-time token and the state cookie.
    const policy = publicRoute("one-time setup token from the server's terminal (development)");
    scope.get(SETUP_PATH, { config: { policy } }, async (request, reply) => {
      const token = param(request, "token");
      const org = param(request, "org");
      if (org === null || (org !== undefined && !isOrganizationLogin(org))) {
        log(request, "warn", "bad_org");
        return send(
          reply,
          400,
          "Invalid organization",
          "<p>The organization login is not valid.</p>",
        );
      }

      if (token !== undefined) {
        // Hash both sides to a fixed length, then compare in constant time.
        // The token is 256-bit, so guessing is hopeless; the lockout still bounds attempts (a
        // rate limit for a route that has no other client to serve).
        const locked = tokenFailures >= MAX_TOKEN_FAILURES;
        const ok =
          token !== null && !tokenUsed && !locked && timingSafeEqual(sha256(token), tokenHash);
        if (!ok) {
          if (!locked) tokenFailures += 1;
          log(request, "warn", locked ? "token_locked" : "bad_token");
          return forbidden(reply);
        }
        tokenUsed = true;
        const session = randomToken();
        sessions.set(sha256(session).toString("hex"), { expiresAt: now() + SETUP_SESSION_TTL_MS });
        log(request, "info", "session_started");
        const cookie = [
          `${SETUP_COOKIE}=${session}`,
          `Path=${SETUP_PATH}`,
          `Max-Age=${SETUP_SESSION_TTL_MS / 1000}`,
          "HttpOnly",
          "SameSite=Lax",
          ...(secure ? ["Secure"] : []),
        ].join("; ");
        // Fixed, relative target: the only dynamic part is a validated organization login.
        const location = org === undefined ? SETUP_PATH : `${SETUP_PATH}?org=${org}`;
        return reply.code(303).header("set-cookie", cookie).header("location", location).send();
      }

      const session = sessionOf(request);
      if (session === undefined) {
        log(request, "warn", "no_session");
        return forbidden(reply);
      }
      if (deps.webhookUrl === undefined) {
        return send(
          reply,
          409,
          "Webhook URL needed",
          "<p>GitHub must reach Rocky's webhook receiver over https. Set <code>GITHUB_APP_WEBHOOK_URL</code> (for local development, a smee.io channel URL; see <code>docs/runbooks/h3-create-github-app.md</code>) or an https <code>ROCKY_PUBLIC_URL</code>, then restart the server.</p>",
        );
      }

      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite !== undefined && !STATE_FETCH_SITES.has(String(fetchSite))) {
        log(request, "warn", "cross_site_page");
        return send(
          reply,
          403,
          "Open this page directly",
          "<p>The setup page was opened from another site. Open it from the address bar or from the link the server printed.</p>",
        );
      }

      // Before sending the human to GitHub: the conversion's secrets can be fetched only once.
      try {
        await checkCredentialsTarget(deps.credentialsFile);
      } catch (error) {
        const reason = error instanceof CredentialsFileError ? error.reason : "io";
        log(request, "warn", "credentials_target_unusable", { reason });
        return send(
          reply,
          409,
          "Credentials file unusable",
          `<p>Rocky will not overwrite <code>${escapeHtml(deps.credentialsFile)}</code> or write into a directory others can modify (${escapeHtml(reason)}). Move it away or set <code>GITHUB_APP_CREDENTIALS_FILE</code>, then reload.</p>`,
        );
      }

      const state = randomToken();
      const mine = [...states].filter(([, s]) => s.session === session);
      for (const [key] of mine.slice(0, Math.max(0, mine.length - (MAX_STATES - 1)))) {
        states.delete(key);
      }
      states.set(sha256(state).toString("hex"), {
        session,
        org,
        expiresAt: now() + SETUP_STATE_TTL_MS,
      });
      const manifest = buildGitHubAppManifest({
        name: deps.appName,
        publicUrl: deps.publicUrl,
        webhookUrl: deps.webhookUrl,
        ...(deps.homepageUrl === undefined ? {} : { homepageUrl: deps.homepageUrl }),
      });
      const action = manifestFormAction(deps.endpoints, state, org);
      const owner = org === undefined ? "your personal account" : `the organization ${org}`;
      log(request, "info", "page_rendered", { org: org !== undefined });
      // The form POSTs cross-origin to GitHub; with `no-referrer` browsers send `Origin: null`,
      // which GitHub may refuse. This URL carries no secret (the token was dropped by the 303).
      void reply.header("referrer-policy", "strict-origin");
      return send(
        reply,
        200,
        "Create the Rocky Reviews GitHub App",
        `<p>This creates a private GitHub App owned by ${escapeHtml(owner)} with read access to code, checks and metadata and write access to pull requests (to post reviews a person submits). GitHub shows the details before you confirm.</p>` +
          `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>` +
          `<p>To create it under an organization instead, open <code>${escapeHtml(SETUP_PATH)}?org=&lt;organization&gt;</code>.</p>`,
      );
    });

    scope.get(SETUP_CALLBACK, { config: { policy } }, async (request, reply) => {
      const session = sessionOf(request);
      if (session === undefined) {
        log(request, "warn", "no_session");
        return forbidden(reply);
      }
      const code = param(request, "code");
      const state = param(request, "state");
      if (typeof state !== "string" || !TOKEN_SHAPE.test(state) || !isManifestCode(code)) {
        log(request, "warn", "bad_parameters");
        return send(
          reply,
          400,
          "Invalid callback",
          "<p>The callback parameters are missing or malformed. Start again from the setup page.</p>",
        );
      }
      const stateKey = sha256(state).toString("hex");
      const pending = states.get(stateKey);
      // Single use: removed on first presentation, whatever happens next.
      if (pending !== undefined) states.delete(stateKey);
      if (pending === undefined || pending.session !== session || pending.expiresAt <= now()) {
        log(request, "warn", "bad_state");
        return send(
          reply,
          403,
          "Invalid or expired state",
          "<p>Start again from the setup page.</p>",
        );
      }
      const codeKey = sha256(code).toString("hex");
      if (exchanging || usedCodes.has(codeKey)) {
        log(request, "warn", exchanging ? "busy" : "code_reused");
        return send(
          reply,
          409,
          "Already in progress or used",
          "<p>This code was already used, or another attempt is running. Start again from the setup page.</p>",
        );
      }
      // Claimed synchronously, before any await, so concurrent callbacks cannot both pass.
      exchanging = true;
      usedCodes.add(codeKey);
      try {
        // Refuse before the exchange: GitHub returns the secrets only once.
        try {
          await checkCredentialsTarget(deps.credentialsFile);
        } catch (error) {
          const reason = error instanceof CredentialsFileError ? error.reason : "io";
          log(request, "error", "credentials_target_unusable", { reason });
          return send(
            reply,
            409,
            "Credentials file unusable",
            `<p>Rocky will not overwrite <code>${escapeHtml(deps.credentialsFile)}</code> or write into a directory others can modify (${escapeHtml(reason)}), so it did not fetch the new app's credentials. The app already exists on GitHub: delete it at ${link(appsList(pending.org))}, fix the file, restart the server and start again.</p>`,
          );
        }

        let credentials;
        try {
          credentials = await convertManifestCode({
            api: deps.endpoints.api,
            code,
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          });
        } catch (error) {
          const e = error instanceof ManifestConversionError ? error : undefined;
          log(request, "error", "conversion_failed", {
            reason: e?.reason ?? "unknown",
            ...(e?.status === undefined ? {} : { status: e.status }),
          });
          const apps = appsList(pending.org);
          return send(
            reply,
            502,
            "GitHub did not complete the setup",
            `<p>Fetching the new app's credentials failed (${escapeHtml(e?.reason ?? "unknown")}${e?.status === undefined ? "" : ` ${e.status}`}). GitHub only sends this page a code after the app is created, so <strong>the app most likely already exists</strong> on GitHub, without credentials saved here. Find it at ${link(apps)}, then either:</p>` +
              `<ul><li>delete it (Advanced → Danger zone) and start again from <a href="${escapeHtml(SETUP_PATH)}">the setup page</a>, or</li>` +
              `<li>keep it and set it up by hand in its settings: note the App ID and Client ID, generate a client secret and a private key, set a webhook secret (at least 32 characters, e.g. <code>openssl rand -hex 32</code>), and store them as the runbook describes.</li></ul>`,
          );
        }

        const settings =
          credentials.slug === undefined
            ? appsList(pending.org)
            : new URL(
                pending.org === undefined
                  ? `settings/apps/${credentials.slug}/advanced`
                  : `organizations/${pending.org}/settings/apps/${credentials.slug}/advanced`,
                deps.endpoints.web,
              ).href;
        const widened = widenedGrants(credentials.permissions, credentials.events);
        if (widened.length > 0) {
          log(request, "error", "grants_widened", { widened });
          return send(
            reply,
            502,
            "The app has more access than Rocky asked for",
            `<p>GitHub reports permissions or events beyond the manifest, so Rocky did not save the credentials. Please delete this app (Danger zone at <a href="${escapeHtml(settings)}">${escapeHtml(settings)}</a>) and start again.</p>`,
          );
        }

        const githubSecret = usableWebhookSecret(credentials.webhookSecret);
        const webhookSecret = githubSecret ?? randomBytes(32).toString("hex");
        const webhookSecretSource = githubSecret === undefined ? "generated" : "github";
        try {
          await writeCredentialsOnce(
            deps.credentialsFile,
            credentialsEnvText({
              appId: credentials.appId,
              slug: credentials.slug,
              clientId: credentials.clientId,
              clientSecret: credentials.clientSecret,
              privateKeyPem: credentials.privateKeyPem,
              webhookSecret,
              webhookSecretSource,
            }),
          );
        } catch (error) {
          const reason = error instanceof CredentialsFileError ? error.reason : "io";
          log(request, "error", "credentials_write_failed", { reason });
          return send(
            reply,
            500,
            "Could not save the credentials",
            `<p>The app was created on GitHub but its credentials could not be written (${escapeHtml(reason)}). They cannot be fetched again: delete the app (<a href="${escapeHtml(settings)}">${escapeHtml(settings)}</a>) and start again.</p>`,
          );
        }

        done = true;
        sessions.clear();
        states.clear();
        log(request, "info", "created", { webhookSecretSource });
        const install =
          credentials.slug === undefined
            ? undefined
            : new URL(`apps/${credentials.slug}/installations/new`, deps.endpoints.web).href;
        return send(
          reply,
          200,
          "GitHub App created",
          `<p>The credentials were written once to <code>${escapeHtml(deps.credentialsFile)}</code> (readable only by you). Move them into your secret manager, or <code>.env</code> in development, then delete the file.</p>` +
            (webhookSecretSource === "generated"
              ? `<p><strong>Webhook secret:</strong> GitHub did not return a usable one, so Rocky generated <code>GITHUB_WEBHOOK_SECRET</code> in that file. Paste it into the app's webhook settings on GitHub before installing.</p>`
              : "") +
            (install === undefined
              ? `<p>Next, install the app on your repositories: GitHub did not return its slug, so open it from ${link(appsList(pending.org))}, choose <em>Install App</em>, and add <code>GITHUB_APP_SLUG</code> (the last part of its public URL) to your settings. Setup is now closed on this server.</p>`
              : `<p>Next, install the app on your repositories: ${link(install)}. Setup is now closed on this server.</p>`),
        );
      } finally {
        exchanging = false;
      }
    });
  });
};
