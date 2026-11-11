import {
  AvailableRepositoriesResponse,
  ConnectionResponse,
  InboxResponse,
  InboxSync,
  personalTokenKind,
  SyncResponse,
  TOKEN_SAVE_REFUSALS,
  SYNC_PROBLEMS,
  ADD_REPOSITORY_REFUSALS,
} from "@rocky-reviews/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_FIXTURE, INBOX_FIXTURE_NOW } from "../inbox/fixtures.js";
import { Inbox } from "../inbox/Inbox.js";
import { createFixtureInboxSource } from "../inbox/inbox-source.js";
import { SyncBar } from "../inbox/SyncBar.js";
import { pageFor } from "../route.js";
import { fetchSignInMethod } from "../session.js";
import { SignInText, TOKEN_LINK_COMMAND } from "../SignIn.js";
import { Connection } from "./Connection.js";
import {
  addRefusalText,
  localTime,
  needsNewToken,
  SYNC_POLL_LIMIT,
  SYNC_POLL_MS,
  syncBar,
  syncProblemText,
  syncReportText,
  takeToken,
  tokenRefusalText,
} from "./connection-model.js";
import {
  AVAILABLE_PATH,
  CONNECTION_PATH,
  ConnectionLoadError,
  createHttpConnectionSource,
  REPOSITORIES_PATH,
  SYNC_PATH,
  TOKEN_PATH,
  type ConnectionSource,
} from "./connection-source.js";
import {
  ADDED_REPOSITORY,
  AVAILABLE,
  CONNECTION,
  CONNECTION_EMPTY,
  CONNECTION_NO_TOKEN,
  fakeToken,
  INBOX_SYNC,
  SYNC_RATE_LIMITED,
  SYNCED,
} from "./fixtures.js";
import { TokenForm } from "./TokenForm.js";

/**
 * P10-4 (ADR 0045): token mode in the web app. The models, the HTTP source and static renders;
 * the interactions (picker, sync, replace, remove) run in Playwright
 * (`e2e/connection.e2e.spec.ts`), the screenshots in `e2e/connection.visual.spec.ts`.
 */

const NOW = Date.parse(INBOX_FIXTURE_NOW);
const RETRY = "2026-10-25T12:40:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the token-mode fixtures", () => {
  it("are valid wire data", () => {
    for (const c of [CONNECTION, CONNECTION_NO_TOKEN, CONNECTION_EMPTY])
      expect(() => ConnectionResponse.parse(c)).not.toThrow();
    expect(() => AvailableRepositoriesResponse.parse(AVAILABLE)).not.toThrow();
    for (const s of [SYNCED, SYNC_RATE_LIMITED, ADDED_REPOSITORY.sync])
      expect(() => SyncResponse.parse(s)).not.toThrow();
    for (const s of Object.values(INBOX_SYNC)) expect(() => InboxSync.parse(s)).not.toThrow();
    expect(() => InboxResponse.parse({ ...INBOX_FIXTURE, sync: INBOX_SYNC.running })).not.toThrow();
  });

  it("assemble a token-shaped value at run time (no literal in the source)", () => {
    expect(fakeToken()).toMatch(/^github_pat_[A-Za-z0-9_]{20,}$/);
    expect(fakeToken("classic")).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(personalTokenKind(fakeToken())).toBe("fine_grained");
    expect(personalTokenKind(fakeToken("classic"))).toBe("classic");
  });
});

describe("the connection model", () => {
  it("has plain text for every refusal code, and names unknown codes without echoing them", () => {
    for (const code of TOKEN_SAVE_REFUSALS) {
      const text = tokenRefusalText(code, RETRY);
      expect(text, code).not.toMatch(/could not save this token \(/);
    }
    expect(tokenRefusalText("token_rejected", null)).toBe(
      "GitHub did not accept this token: it may be mistyped, expired or revoked.",
    );
    expect(tokenRefusalText("token_user_mismatch", null)).toBe(
      "This token belongs to another GitHub user than the one Rocky is connected to.",
    );
    expect(tokenRefusalText("not_a_personal_token", null)).toBe(
      "This is not a personal access token (github_pat_… or ghp_…).",
    );
    expect(tokenRefusalText("missing_permissions", null)).toContain("repo or public_repo");
    expect(tokenRefusalText("something_new", null)).toBe(
      "Rocky could not save this token (something_new).",
    );
    expect(tokenRefusalText("<b>x</b>", null)).toBe("Rocky could not save this token (error).");
    for (const code of SYNC_PROBLEMS) expect(syncProblemText(code, RETRY), code).not.toBe("");
    for (const code of ADD_REPOSITORY_REFUSALS)
      expect(addRefusalText(code, RETRY), code).not.toBe("");
    expect(addRefusalText("<x>", null)).toBe("The repository could not be added (error).");
  });

  it("shows a rate limit's reset as a local time of day", () => {
    const text = tokenRefusalText("rate_limited", RETRY);
    expect(text).toContain(localTime(RETRY));
    expect(text).toMatch(/Try again after \d{1,2}:\d{2}/);
    expect(syncProblemText("rate_limited", null)).toContain("Try again after later");
    expect(localTime("not a time")).toBe("later");
  });

  it("links a new token only where one fixes the problem", () => {
    expect(needsNewToken("token_rejected")).toBe(true);
    expect(needsNewToken("no_token")).toBe(true);
    expect(needsNewToken("rate_limited")).toBe(false);
    expect(needsNewToken(null)).toBe(false);
  });

  it("says what a sync read, in counts", () => {
    expect(syncReportText(SYNCED)).toBe(
      "Synced: 5\u00a0open pull requests, 1\u00a0updated, 1\u00a0analysis queued.",
    );
    expect(syncReportText(SYNC_RATE_LIMITED)).toContain("rate limit");
    expect(syncReportText({ ...SYNCED, outcome: "busy" })).toBe("A sync is already running.");
  });

  it("the sync bar's state follows the inbox's sync", () => {
    expect(syncBar(INBOX_SYNC.running)).toEqual({ kind: "running" });
    expect(syncBar(INBOX_SYNC.synced)).toEqual({ kind: "idle" });
    expect(syncBar({ ...INBOX_SYNC.synced, state: "skipped" })).toEqual({ kind: "idle" });
    expect(syncBar(INBOX_SYNC.rateLimited)).toMatchObject({ kind: "problem", replaceToken: false });
    expect(syncBar(INBOX_SYNC.tokenRejected)).toMatchObject({
      kind: "problem",
      replaceToken: true,
    });
    // Bounded: about half a minute of asking again.
    expect(SYNC_POLL_MS * SYNC_POLL_LIMIT).toBeLessThanOrEqual(60_000);
  });

  it("takes the token out of its field and empties the field", () => {
    const token = fakeToken();
    const field = { value: `  ${token} ` };
    expect(takeToken(field)).toBe(token);
    expect(field.value).toBe("");
    expect(takeToken({ value: "   " })).toBeNull();
    expect(takeToken(null)).toBeNull();
  });
});

describe("the token field", () => {
  it("is a password field with no value rendered", () => {
    const html = renderToStaticMarkup(
      <TokenForm
        label="Token"
        submitLabel="Save"
        busyLabel="Saving…"
        onSubmit={async () => null}
      />,
    );
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('spellCheck="false"');
    expect(html).not.toContain("value=");
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[\s\S]*<input[^>]*id="\1"/);
  });
});

const source: ConnectionSource = {
  load: () => Promise.resolve(CONNECTION),
  saveToken: () => Promise.resolve({ kind: "error" }),
  removeToken: () => Promise.resolve({ kind: "ok", value: null }),
  available: () => Promise.resolve({ kind: "ok", value: AVAILABLE }),
  addRepository: () => Promise.resolve({ kind: "error" }),
  removeRepository: () => Promise.resolve({ kind: "ok", value: null }),
  sync: () => Promise.resolve({ kind: "ok", value: SYNCED }),
};

const renderConnection = (data: ConnectionResponse) =>
  renderToStaticMarkup(
    <Connection
      data={data}
      now={NOW}
      mode="light"
      onToggleMode={() => undefined}
      source={source}
      onReload={() => Promise.resolve()}
    />,
  );

describe("the connection page", () => {
  it("describes the token without its value, the repositories and the sync", () => {
    const html = renderConnection(CONNECTION);
    expect(html).toContain("@sam-r");
    expect(html).toContain("Fine-grained");
    expect(html).toContain("Replace token");
    expect(html).toContain("Remove token");
    expect(html).toContain("sam-r/rocky-app");
    expect(html).toContain("acme/billing-api");
    expect(html).toContain("4\u00a0open pull requests · synced 3 min ago");
    expect(html).toContain('aria-label="Stop following acme/billing-api"');
    expect(html).toContain("Last synced 3 min ago");
    expect(html).toContain("analysed automatically.");
    expect(html).not.toContain("github_pat_");
    expect(html).not.toContain('type="password"');
  });

  it("no token: says Rocky stops, and asks for one", () => {
    const html = renderConnection(CONNECTION_NO_TOKEN);
    expect(html).toContain("No token is saved");
    expect(html).toMatch(/type="submit"[^>]*>Save token</);
    expect(html).toContain("ROCKY_ANALYSIS_AUTO=off");
  });

  it("a classic token without expiry: both warnings; nothing followed yet", () => {
    const html = renderConnection(CONNECTION_EMPTY);
    expect(html).toContain("Classic token</span>");
    expect(html).toContain("Never expires</span>");
    expect(html).toContain("Rocky follows no repository yet");
    expect(html).toContain("Not synced yet");
  });

  it("is reached at /connection, whatever the switches", () => {
    for (const fixtures of [true, false]) {
      expect(pageFor("/connection", "", { fixtures })).toEqual({ kind: "connection" });
      expect(pageFor("/connection/", "", { fixtures })).toEqual({ kind: "connection" });
    }
  });
});

describe("the inbox in token mode", () => {
  const inbox = InboxResponse.parse(INBOX_FIXTURE);
  const render = (sync?: InboxSync) =>
    renderToStaticMarkup(
      <Inbox
        items={inbox.items}
        now={NOW}
        mode="light"
        onToggleMode={() => undefined}
        source={createFixtureInboxSource()}
        onReload={() => undefined}
        sync={sync}
        onSync={() => Promise.resolve({ kind: "ok", value: SYNCED })}
      />,
    );

  it("App mode (no sync field): no sync bar, no connection link", () => {
    const html = render();
    expect(html).not.toContain("sync-bar");
    expect(html).not.toContain('href="/connection"');
  });

  it("shows when it last synced, the Sync button and the way to the connection page", () => {
    const html = render(INBOX_SYNC.synced);
    expect(html).toContain("Last synced 3 min ago");
    expect(html).toMatch(/<button[^>]*>.*Sync<\/button>/);
    expect(html).toContain('href="/connection"');
    expect(html).toContain('role="status"');
  });

  it("running: Syncing…, and the button is unavailable", () => {
    const html = render(INBOX_SYNC.running);
    expect(html).toContain("Syncing with GitHub…");
    expect(html).toMatch(/aria-disabled="true"[^>]*>.*Sync</);
  });

  it("failed: the problem as an alert; a refused token links to replacing it", () => {
    const limited = render(INBOX_SYNC.rateLimited);
    expect(limited).toMatch(/role="alert">GitHub&#x27;s rate limit for this token is used up/);
    expect(limited).not.toContain("Replace the token");
    const rejected = renderToStaticMarkup(
      <SyncBar
        sync={INBOX_SYNC.tokenRejected}
        now={NOW}
        onSync={() => Promise.resolve({ kind: "error" })}
      />,
    );
    expect(rejected).toMatch(/<a href="\/connection">Replace the token<\/a>/);
  });
});

describe("signing in (P10-4)", () => {
  it("token mode: the one-time link from the log, no GitHub login", () => {
    const html = renderToStaticMarkup(<SignInText method="token_link" rest="to see your inbox." />);
    expect(html).toContain(TOKEN_LINK_COMMAND);
    expect(html).toContain("Each link works once; restart the server for a new one.");
    expect(html).not.toContain("Sign in with GitHub");
    expect(html).not.toContain("<a");
  });

  it("App mode: Sign in with GitHub, back to the page", () => {
    const html = renderToStaticMarkup(
      <SignInText method="github" returnTo="/inbox" rest="to see your inbox." />,
    );
    expect(html).toContain('href="/auth/github/login?returnTo=%2Finbox"');
    expect(html).toContain("Sign in with GitHub</a> to see your inbox.");
  });

  it("reads the method from the session's 401 answer; anything else is GitHub", async () => {
    const answer = (status: number, body: unknown) =>
      vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(body), { status })));
    answer(401, { authenticated: false, signIn: "token_link" });
    expect(await fetchSignInMethod()).toBe("token_link");
    answer(401, { authenticated: false, signIn: "github" });
    expect(await fetchSignInMethod()).toBe("github");
    answer(401, { authenticated: false });
    expect(await fetchSignInMethod()).toBe("github");
    answer(200, { authenticated: true });
    expect(await fetchSignInMethod()).toBe("github");
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    expect(await fetchSignInMethod()).toBe("github");
  });
});

describe("the connection source", () => {
  const SESSION = { authenticated: true, csrfToken: "csrf-1" };
  /** Answers the session, then `answer` for everything else; records every request. */
  const server = (answer: (url: string, init: RequestInit) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
      if (url === "/api/session") return Promise.resolve(new Response(JSON.stringify(SESSION)));
      calls.push({ url, init });
      return Promise.resolve(answer(url, init));
    });
    return calls;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const csrfOf = (init: RequestInit) => (init.headers as Record<string, string>)["x-rocky-csrf"];

  it("loads and validates; 401, 404 and bad answers are reasons, not content", async () => {
    server(() => json(CONNECTION));
    expect(await createHttpConnectionSource().load()).toEqual(CONNECTION);
    for (const [status, reason] of [
      [401, "signed_out"],
      [404, "app_mode"],
      [500, "failed"],
    ] as const) {
      server(() => json({}, status));
      await expect(createHttpConnectionSource().load()).rejects.toEqual(
        new ConnectionLoadError(reason),
      );
    }
    server(() => json({ ...CONNECTION, token: { ...CONNECTION.token, value: "x" } }));
    await expect(createHttpConnectionSource().load()).rejects.toEqual(
      new ConnectionLoadError("failed"),
    );
  });

  it("sends every change with the session's CSRF token, to the right route", async () => {
    const token = fakeToken();
    const calls = server((url, init) => {
      if (url === TOKEN_PATH && init.method === "PUT") return json({ token: CONNECTION.token });
      if (url === AVAILABLE_PATH) return json(AVAILABLE);
      if (url === REPOSITORIES_PATH) return json(ADDED_REPOSITORY);
      if (url === SYNC_PATH) return json(SYNCED);
      return new Response(null, { status: 204 });
    });
    const http = createHttpConnectionSource();
    const repoId = CONNECTION.repositories[0]?.id ?? "";
    const body = (i: number) => JSON.parse(calls[i]?.init.body as string) as unknown;
    expect(await http.saveToken(token)).toMatchObject({ kind: "ok" });
    expect(await http.removeToken()).toEqual({ kind: "ok", value: null });
    expect(await http.available()).toEqual({ kind: "ok", value: AVAILABLE });
    expect(await http.addRepository(81_220_003)).toMatchObject({ kind: "ok" });
    expect(await http.removeRepository(repoId)).toMatchObject({
      kind: "ok",
    });
    expect(await http.sync()).toEqual({ kind: "ok", value: SYNCED });
    expect(calls.map((c) => `${c.init.method ?? "GET"} ${c.url}`)).toEqual([
      `PUT ${TOKEN_PATH}`,
      `DELETE ${TOKEN_PATH}`,
      `GET ${AVAILABLE_PATH}`,
      `POST ${REPOSITORIES_PATH}`,
      `DELETE ${REPOSITORIES_PATH}/${repoId}`,
      `POST ${SYNC_PATH}`,
    ]);
    for (const call of calls.filter((c) => c.init.method !== undefined))
      expect(csrfOf(call.init), call.url).toBe("csrf-1");
    expect(body(0)).toEqual({ token });
    expect(body(3)).toEqual({ forgeRepoId: 81_220_003 });
    expect(body(5)).toEqual({});
    expect(CONNECTION_PATH).toBe("/api/connection");
  });

  it("reads refusals by code; anything else is an error", async () => {
    server(() => json({ error: "token_rejected", retryAt: null }, 422));
    expect(await createHttpConnectionSource().saveToken(fakeToken())).toEqual({
      kind: "refused",
      error: "token_rejected",
      retryAt: null,
    });
    server(() => json({ error: "<script>", retryAt: null }, 422));
    expect(await createHttpConnectionSource().saveToken(fakeToken())).toEqual({ kind: "error" });
    server(() => json({ error: "not_found", retryAt: null }, 404));
    expect(await createHttpConnectionSource().removeRepository("../x")).toEqual({ kind: "error" });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    expect(await createHttpConnectionSource().sync()).toEqual({ kind: "error" });
  });
});
