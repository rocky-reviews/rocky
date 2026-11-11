import rateLimit from "@fastify/rate-limit";
import {
  ConnectionErrorResponse,
  SaveTokenRequest,
  SaveTokenResponse,
  SetupProbeResponse,
  SetupStatusResponse,
  type SetupProbeResult,
  type SetupStatusResponse as Status,
} from "@rocky-reviews/core";
import { LlmConfigError } from "@rocky-reviews/llm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CSRF_EXEMPT_SETUP } from "../auth/csrf.js";
import { publicRoute } from "../auth/policy.js";
import {
  peerAddress,
  sendSetupPage,
  STYLE,
  SETUP_RATE_LIMIT_PER_MINUTE,
} from "../github-app-setup.js";
import { pageCsp } from "../security/headers.js";
import type { WebFile } from "../web-app.js";
import type { SetupChecks } from "./checks.js";
import type { SetupSessions } from "./session.js";

/**
 * The setup wizard's routes (P10-2, ADR 0044):
 *
 *   GET  /setup/start?token=T  the one-time boot token → setup session cookie, 303 to /setup
 *   GET  /setup                the wizard page (the web app's shell; Vite serves it in development)
 *   GET  /api/setup/status     every step's state (database, GitHub App, LLM, first repository)
 *   POST /api/setup/llm-test   the provider test call (`probeLlmConfig`), one at a time
 *   POST /api/setup/finish     closes setup until the server restarts
 *   POST /api/setup/token      token mode (P10-4, ADR 0045): validates and stores the personal
 *                              token, then signs the operator in (a login session cookie)
 *
 * Every route but the page needs the setup session; the POSTs also pass the setup session's CSRF
 * check (same origin, synchronizer token). Answers are validated against the core schemas before
 * they are sent, and logs carry outcome codes only.
 */

export const WIZARD_START = "/setup/start";
export const WIZARD_PAGE = "/setup";
export const STATUS_PATH = "/api/setup/status";
export const LLM_TEST_PATH = "/api/setup/llm-test";
export const FINISH_PATH = "/api/setup/finish";
export const TOKEN_PATH = "/api/setup/token";
/** A test call spends a little money: at most one per this interval. */
export const LLM_TEST_INTERVAL_MS = 10_000;

export interface SetupWizardDeps {
  readonly sessions: SetupSessions;
  readonly checks: SetupChecks;
  readonly mode: Status["mode"];
  /**
   * Token mode (P10-4): saving the token (validated with GitHub, stored encrypted; never echoed)
   * and the login session for its owner that the save opens (`Set-Cookie` value).
   */
  readonly tokenMode?: SetupTokenDeps;
  /** The built web app's shell, served at `/setup`; absent in development (Vite serves it). */
  readonly page?: WebFile;
  /**
   * The client address key (`RateLimits.clientKey`: `ROCKY_TRUST_PROXY` decides which address);
   * defaults to the socket's peer. Keys the rate limit and the token lockout.
   */
  readonly clientKey?: (request: FastifyRequest) => string;
  readonly now?: () => number;
}

export interface SetupTokenDeps {
  readonly save: (
    token: string,
  ) => Promise<
    | { readonly ok: true; readonly token: SaveTokenResponse["token"] }
    | { readonly ok: false; readonly reason: string; readonly retryAt?: Date }
  >;
  readonly signIn: (request: FastifyRequest) => Promise<string | null>;
}

/** HTTP status per refusal of a token save (shared with the connection routes). */
export const tokenRefusalStatus = (reason: string): number =>
  reason === "rate_limited" ? 429 : reason === "forge_unavailable" ? 502 : 422;

const NOT_FOUND = { error: "not_found" } as const;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const registerSetupWizard = (app: FastifyInstance, deps: SetupWizardDeps): void => {
  const now = deps.now ?? Date.now;
  const clientKey = deps.clientKey ?? peerAddress;
  let probing = false;
  let lastProbeAt = -Infinity;
  let lastResults: SetupProbeResult[] | null = null;
  const policy = publicRoute("setup wizard: the one-time setup token's session (P10-2)");

  const log = (request: FastifyRequest, level: "info" | "warn", outcome: string, extra = {}) =>
    request.log[level]({ setupWizard: { outcome, ...extra } }, "setup wizard");

  const json = (reply: FastifyReply, status: number, body: unknown) =>
    reply.code(status).header("cache-control", "no-store").send(body);

  /** Session (and for POSTs, the CSRF check) or a fixed refusal. */
  const guard = (request: FastifyRequest, reply: FastifyReply, post: boolean) => {
    if (deps.sessions.sessionOf(request) === undefined) {
      log(request, "warn", "no_session");
      return json(reply, 403, { error: "setup_session_required" });
    }
    if (post) {
      const refusal = deps.sessions.checkCsrf(request);
      if (refusal !== undefined) {
        log(request, "warn", "csrf_refused", { reason: refusal });
        return json(reply, 403, { error: "csrf" });
      }
    }
    return undefined;
  };

  void app.register(async (scope) => {
    await scope.register(rateLimit, {
      max: SETUP_RATE_LIMIT_PER_MINUTE,
      timeWindow: 60_000,
      keyGenerator: clientKey,
    });
    scope.addHook("onRequest", async (_request, reply) => {
      if (deps.sessions.closed) return reply.code(404).send(NOT_FOUND);
      return undefined;
    });

    scope.get(WIZARD_START, { config: { policy } }, async (request, reply) => {
      void reply
        .header("content-security-policy", pageCsp({ style: STYLE }))
        // The URL carries the token: it must not leave in a Referer.
        .header("referrer-policy", "no-referrer")
        .header("cache-control", "no-store");
      const query = request.query as Record<string, unknown>;
      const raw = query["token"];
      const token = typeof raw === "string" && TOKEN.test(raw) ? raw : null;
      const redeemed = deps.sessions.redeem(token, clientKey(request));
      if (!redeemed.ok) {
        log(request, "warn", redeemed.reason);
        return sendSetupPage(
          reply,
          403,
          "Setup link required",
          "<p>Open the one-time setup URL printed in the server's log. If you already used it, restart the server to get a new one.</p>",
        );
      }
      log(request, "info", "session_started");
      return reply
        .code(303)
        .header("set-cookie", redeemed.cookie)
        .header("location", WIZARD_PAGE)
        .send();
    });

    scope.get(WIZARD_PAGE, { config: { policy } }, async (_request, reply) => {
      if (deps.page === undefined) {
        // Development: Vite serves the page. Reached here, the link pointed at the server itself.
        void reply
          .header("content-security-policy", pageCsp({ style: STYLE }))
          .header("cache-control", "no-store");
        return sendSetupPage(
          reply,
          404,
          "The setup page is served by Vite",
          "<p>This server has no built web app (<code>ROCKY_WEB_DIR</code>). Under <code>pnpm dev</code>, set <code>ROCKY_PUBLIC_URL=http://127.0.0.1:5173</code> (the Vite origin, which proxies the setup routes here), restart the server and open the new link it prints.</p>",
        );
      }
      return reply
        .header("content-type", deps.page.contentType)
        .header("cache-control", "no-store")
        .send(deps.page.body);
    });

    scope.get(STATUS_PATH, { config: { policy } }, async (request, reply) => {
      const refused = guard(request, reply, false);
      if (refused !== undefined) return refused;
      const csrfToken = deps.sessions.csrfTokenOf(request);
      if (csrfToken === undefined) return json(reply, 403, { error: "setup_session_required" });
      const [database, githubApp, repositories] = await Promise.all([
        deps.checks.database(),
        deps.checks.githubApp(),
        deps.checks.repositories(),
      ]);
      const llm = deps.checks.llm();
      const failed = lastResults?.some((r) => r.outcome !== "ok" && r.outcome !== "answered");
      const body: Status = {
        mode: deps.mode,
        // P10-4: the wizard leads with the App; with `tokenMode` its GitHub step is the token.
        connection: deps.tokenMode === undefined ? "app" : "token",
        csrfToken,
        database,
        githubApp,
        llm: {
          ...llm,
          state:
            llm.state === "invalid_config" || lastResults === null
              ? llm.state
              : failed === true
                ? "failed"
                : "ok",
          results: llm.state === "invalid_config" ? null : lastResults,
        },
        repositories,
      };
      const checked = SetupStatusResponse.safeParse(body);
      if (!checked.success) {
        log(request, "warn", "status_invalid");
        return json(reply, 500, { error: "internal" });
      }
      return json(reply, 200, checked.data);
    });

    scope.post(
      LLM_TEST_PATH,
      { config: { policy, csrfExempt: CSRF_EXEMPT_SETUP } },
      async (request, reply) => {
        const refused = guard(request, reply, true);
        if (refused !== undefined) return refused;
        if (probing) return json(reply, 409, { error: "busy" });
        if (now() - lastProbeAt < LLM_TEST_INTERVAL_MS) {
          return json(reply, 429, { error: "too_soon" });
        }
        probing = true;
        lastProbeAt = now();
        try {
          let results;
          try {
            results = await deps.checks.probe();
          } catch (error) {
            log(request, "warn", "llm_test_config", {
              reason: error instanceof LlmConfigError ? "invalid_config" : "failed",
            });
            return json(reply, 409, { error: "invalid_config" });
          }
          const body = { results: results.map((r) => ({ ...r, roles: [...r.roles] })) };
          const checked = SetupProbeResponse.safeParse(body);
          if (!checked.success) return json(reply, 500, { error: "internal" });
          lastResults = checked.data.results;
          // Provider, model and outcome: never the prompt, the answer or the key.
          log(request, "info", "llm_test", {
            results: lastResults.map((r) => ({
              provider: r.provider,
              model: r.model,
              outcome: r.outcome,
              durationMs: r.durationMs,
            })),
          });
          return json(reply, 200, checked.data);
        } finally {
          probing = false;
        }
      },
    );

    const tokenMode = deps.tokenMode;
    if (tokenMode !== undefined) {
      /** One save at a time: each one asks GitHub twice. */
      let saving = false;
      scope.post(
        TOKEN_PATH,
        { config: { policy, csrfExempt: CSRF_EXEMPT_SETUP } },
        async (request, reply) => {
          const refused = guard(request, reply, true);
          if (refused !== undefined) return refused;
          const parsed = SaveTokenRequest.safeParse(request.body);
          if (!parsed.success) {
            return json(reply, 400, { error: "invalid_request", retryAt: null });
          }
          if (saving) return json(reply, 409, { error: "busy" });
          saving = true;
          try {
            const result = await tokenMode.save(parsed.data.token);
            if (!result.ok) {
              // The reason only: never the token, never GitHub's message.
              log(request, "info", "token_refused", { reason: result.reason });
              const body = ConnectionErrorResponse.safeParse({
                error: result.reason,
                retryAt: result.retryAt?.toISOString() ?? null,
              });
              if (!body.success) return json(reply, 500, { error: "internal", retryAt: null });
              return json(reply, tokenRefusalStatus(result.reason), body.data);
            }
            const checked = SaveTokenResponse.safeParse({ token: result.token });
            if (!checked.success) return json(reply, 500, { error: "internal", retryAt: null });
            log(request, "info", "token_saved", { kind: result.token.kind });
            // The operator proved the setup link; the token's owner is the only user: sign in.
            const cookie = await tokenMode.signIn(request);
            if (cookie !== null) void reply.header("set-cookie", cookie);
            return json(reply, 200, checked.data);
          } finally {
            saving = false;
          }
        },
      );
    }

    scope.post(
      FINISH_PATH,
      { config: { policy, csrfExempt: CSRF_EXEMPT_SETUP } },
      async (request, reply) => {
        const refused = guard(request, reply, true);
        if (refused !== undefined) return refused;
        deps.sessions.close();
        log(request, "info", "finished");
        return json(reply, 200, { closed: true });
      },
    );
  });
};
