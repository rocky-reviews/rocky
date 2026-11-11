import { describe, expect, it } from "vitest";
import {
  SetupProbeResponse,
  SetupStatusResponse,
  type SetupStatusResponse as Status,
} from "./setup.js";

/** P10-2: the setup wizard's API answers, as both the server and the page check them. */

const status = (overrides: Partial<Status> = {}): Status => ({
  mode: "setup",
  connection: "app",
  csrfToken: "a".repeat(43),
  database: { state: "ok", details: [] },
  githubApp: {
    state: "not_created",
    error: null,
    createPath: "/setup/github-app",
    createBlocked: null,
    credentialsFile: "/setup/github-app.env",
    installUrl: null,
    token: null,
  },
  llm: {
    state: "not_tested",
    configError: null,
    targets: [{ roles: ["triage", "review"], provider: "anthropic", model: "claude-sonnet-5-5" }],
    results: null,
  },
  repositories: { state: "waiting_for_app", error: null, installations: [] },
  ...overrides,
});

describe("SetupStatusResponse (P10-2)", () => {
  it("accepts a fresh instance's status", () => {
    expect(SetupStatusResponse.safeParse(status()).success).toBe(true);
  });

  it("accepts an analysed first repository", () => {
    const value = status({
      mode: "full",
      githubApp: {
        state: "configured",
        error: null,
        createPath: null,
        createBlocked: null,
        credentialsFile: "/setup/github-app.env",
        installUrl: "https://github.com/apps/rocky-reviews/installations/new",
        token: null,
      },
      repositories: {
        state: "analysed",
        error: null,
        installations: [
          {
            account: "acme",
            kind: "organization",
            suspended: false,
            ready: true,
            repositories: 1,
            pullRequests: 1,
            analyses: { queued: 0, running: 0, awaitingApproval: 0, done: 1, failed: 0 },
            latestDone: { fullName: "acme/api", number: 7 },
          },
        ],
      },
    });
    expect(SetupStatusResponse.safeParse(value).success).toBe(true);
  });

  it("refuses unknown fields, an http install link and free-text codes", () => {
    expect(SetupStatusResponse.safeParse({ ...status(), extra: 1 }).success).toBe(false);
    const http = status();
    expect(
      SetupStatusResponse.safeParse({
        ...http,
        githubApp: { ...http.githubApp, installUrl: "http://github.com/apps/x/installations/new" },
      }).success,
    ).toBe(false);
    expect(
      SetupStatusResponse.safeParse({
        ...http,
        githubApp: { ...http.githubApp, state: "check_failed", error: "Bad credentials!" },
      }).success,
    ).toBe(false);
  });
});

describe("SetupProbeResponse (P10-2)", () => {
  it("carries outcomes and durations only", () => {
    const ok = {
      results: [
        {
          roles: ["triage"],
          provider: "openai-compatible",
          model: "qwen2.5-coder:7b",
          outcome: "ok",
          durationMs: 120,
        },
      ],
    };
    expect(SetupProbeResponse.safeParse(ok).success).toBe(true);
    expect(
      SetupProbeResponse.safeParse({ results: [{ ...ok.results[0], answer: "{}" }] }).success,
    ).toBe(false);
  });
});
