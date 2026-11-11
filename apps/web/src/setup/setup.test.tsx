import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_FIXTURES, SETUP_DONE, SETUP_FRESH } from "./fixtures.js";
import { Setup } from "./Setup.js";
import { allDone, outcomeText, pullPath } from "./setup-model.js";
import {
  createHttpSetupSource,
  FINISH_PATH,
  LLM_TEST_PATH,
  parseSetupStatus,
  SetupLoadError,
  STATUS_PATH,
  type SetupSource,
} from "./setup-source.js";

/**
 * P10-2 (ADR 0044): the setup wizard's model, source and static render. The interactions (test
 * call, finish, keyboard) run in Playwright (`e2e/setup.e2e.spec.ts`), the screenshots in
 * `e2e/setup.visual.spec.ts`.
 */

const source: SetupSource = {
  load: () => Promise.resolve(SETUP_FRESH),
  testLlm: () => Promise.resolve({ kind: "error" }),
  finish: () => Promise.resolve(true),
};

const render = (status = SETUP_FRESH, loadProblem = false) =>
  renderToStaticMarkup(
    <Setup
      status={status}
      mode="light"
      onToggleMode={() => undefined}
      source={source}
      onReload={() => Promise.resolve(true)}
      onFinished={() => undefined}
      loadProblem={loadProblem}
    />,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setup fixtures", () => {
  it("are all valid status answers", () => {
    for (const [name, status] of Object.entries(SETUP_FIXTURES)) {
      expect(() => parseSetupStatus(status), name).not.toThrow();
    }
  });
});

describe("the setup model (P10-2)", () => {
  it("builds Rocky's pull request path from validated names only", () => {
    expect(pullPath("acme/rocky-app", 12)).toBe("/acme/rocky-app/pull/12");
    expect(pullPath("acme", 1)).toBeNull();
    expect(pullPath("acme/a/b", 1)).toBeNull();
    expect(pullPath("ac me/x", 1)).toBeNull();
    expect(pullPath("../x", 1)).toBeNull();
  });

  it("is done only when every step is", () => {
    expect(allDone(SETUP_DONE)).toBe(true);
    expect(allDone(SETUP_FRESH)).toBe(false);
  });

  it("explains unknown outcomes without echoing them", () => {
    expect(outcomeText("auth")).toBe("The provider rejected the key");
    expect(outcomeText("<script>")).toBe("The call failed");
  });
});

describe("the setup page (P10-2)", () => {
  it("a fresh server: database done, the app to create, the LLM to test, the repository waiting", () => {
    const html = render();
    expect(html).toContain("Set up Rocky");
    expect(html).toContain('href="/setup/github-app"');
    expect(html).toContain("/setup/github-app.env");
    expect(html).toContain("Run the test call");
    expect(html).toContain("claude-sonnet-5-5");
    expect(html).toContain("Available once the GitHub App is configured");
    expect(html.match(/status-pill setup-pill tone-ok/g)).toHaveLength(1);
  });

  it("after creating the app: restart first, install after", () => {
    const html = render(SETUP_FIXTURES.created);
    expect(html).toContain("Do not install the app before the restart");
    expect(html).not.toContain("installations/new");
  });

  it("after creating the app: Waiting (for the restart), the host path, the commands in a block (fix round)", () => {
    const html = render(SETUP_FIXTURES.created);
    expect(html).toMatch(
      /aria-labelledby="setup-app-title"[\s\S]*?status-pill setup-pill tone-waiting">Waiting</,
    );
    expect(html).toContain("<code>deploy/setup/github-app.env</code> on the host");
    expect(html).toMatch(
      /<pre class="setup-commands"><code>sudo cat deploy\/setup\/github-app.env &gt;&gt; deploy\/rocky.env\nsudo rm deploy\/setup\/github-app.env\n/,
    );
  });

  it("the test call's cost is stated as about a cent or two (fix round)", () => {
    expect(render()).toContain("about a cent or two");
  });

  it("pending migrations: the list is labelled and the command named (fix round)", () => {
    const html = render(SETUP_FIXTURES.failures);
    expect(html).toContain('<p class="setup-details-label" id="setup-db-missing">Missing:</p>');
    expect(html).toContain('aria-labelledby="setup-db-missing"');
    expect(html).toContain("<code>pnpm db:migrate</code>");
    expect(html).toContain("docker compose -f deploy/docker-compose.yml run --rm migrate");
  });

  it("names ROCKY_SETUP=true as code in the finish note (fix round)", () => {
    expect(render()).toContain("<code>ROCKY_SETUP=true</code>");
  });

  it("installed: the install link and the counts per account", () => {
    const html = render(SETUP_FIXTURES.installed);
    expect(html).toContain('href="https://github.com/apps/rocky-reviews/installations/new"');
    // Non-breaking spaces keep each count with its noun (fix round).
    expect(html).toContain("1 repository · 1 pull request · 0 analyses done · 1 in progress");
    expect(html).toContain("ROCKY_ANALYSIS_AUTO=on");
  });

  it("a failed check keeps the last status and says so inline (fix round, item 6)", () => {
    const html = render(SETUP_FRESH, true);
    expect(html).toContain("Set up Rocky");
    expect(html).toMatch(/role="alert"[^>]*>Rocky did not answer the last check/);
    expect(render()).not.toContain("did not answer the last check");
  });

  it("accounts: waiting for the installation event, and suspended", () => {
    const html = render(SETUP_FIXTURES.accounts);
    expect(html).toContain("Waiting for GitHub&#x27;s installation event");
    expect(html).toContain("Suspended on GitHub");
  });

  it("done: links the first analysed pull request and offers to finish", () => {
    const html = render(SETUP_DONE);
    expect(html).toContain('href="/acme/rocky-app/pull/12"');
    expect(html).toMatch(/class="btn btn-primary"[^>]*>Finish setup/);
    expect(html.match(/status-pill setup-pill tone-ok/g)).toHaveLength(4);
  });

  it("failures: names what is missing and what the provider said", () => {
    const html = render(SETUP_FIXTURES.failures);
    expect(html).toContain("Some migrations have not been applied");
    expect(html).toContain("<code>repos.memory_enabled</code>");
    expect(html).toContain("GITHUB_APP_WEBHOOK_URL");
    expect(html).toContain("The provider rejected the key");
    expect(html).toContain("This model is not available to the key");
  });

  it("an invalid LLM configuration is shown as text", () => {
    const html = render({
      ...SETUP_FIXTURES["invalid-llm"],
      llm: { ...SETUP_FIXTURES["invalid-llm"].llm, configError: "<img src=x onerror=alert(1)>" },
    });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });
});

describe("the setup source (P10-2)", () => {
  const stub = (status: number, body: unknown = {}) => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("loads the status and maps refusals to reasons", async () => {
    stub(200, SETUP_FRESH);
    expect(await createHttpSetupSource().load()).toEqual(SETUP_FRESH);
    for (const [status, reason] of [
      [403, "no_session"],
      [404, "closed"],
      [500, "failed"],
    ] as const) {
      stub(status);
      await expect(createHttpSetupSource().load()).rejects.toEqual(new SetupLoadError(reason));
    }
    expect(() => parseSetupStatus({ mode: "setup" })).toThrow(SetupLoadError);
  });

  it("posts the test call with the CSRF token and validates the answer", async () => {
    const results = [
      { roles: ["triage"], provider: "anthropic", model: "m", outcome: "ok", durationMs: 1 },
    ];
    const fetchMock = stub(200, { results });
    expect(await createHttpSetupSource().testLlm("t".repeat(43))).toEqual({
      kind: "done",
      results,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LLM_TEST_PATH);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-rocky-csrf"]).toBe("t".repeat(43));
    stub(200, { results: [{ ...results[0], answer: "leak" }] });
    expect(await createHttpSetupSource().testLlm("t")).toEqual({ kind: "error" });
    stub(409, { error: "invalid_config" });
    expect(await createHttpSetupSource().testLlm("t")).toEqual({ kind: "invalid_config" });
    stub(409, { error: "busy" });
    expect(await createHttpSetupSource().testLlm("t")).toEqual({ kind: "busy" });
    stub(429);
    expect(await createHttpSetupSource().testLlm("t")).toEqual({ kind: "too_soon" });
    stub(403);
    expect(await createHttpSetupSource().testLlm("t")).toEqual({ kind: "error" });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    expect(await createHttpSetupSource().testLlm("t")).toEqual({ kind: "error" });
  });

  it("finishes with a POST", async () => {
    const fetchMock = stub(200, { closed: true });
    expect(await createHttpSetupSource().finish("t")).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0 as never]).toBe(FINISH_PATH);
    stub(403);
    expect(await createHttpSetupSource().finish("t")).toBe(false);
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    expect(await createHttpSetupSource().finish("t")).toBe(false);
    expect(STATUS_PATH).toBe("/api/setup/status");
  });
});
