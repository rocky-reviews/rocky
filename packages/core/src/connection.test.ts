import { describe, expect, it } from "vitest";
import {
  AddRepositoryResponse,
  ConnectionErrorResponse,
  ConnectionResponse,
  InboxSync,
  personalTokenKind,
  SaveTokenRequest,
  SyncResponse,
  TOKEN_EXPIRES_SOON_DAYS,
  tokenWarnings,
} from "./connection.js";
import { ForgeReadError } from "./forge.js";
import { InboxResponse } from "./review-inbox.js";

/** P10-4 (ADR 0045): the token connection's contract. */

const NOW = new Date("2026-11-11T10:00:00Z");
const DAY = 86_400_000;

describe("personalTokenKind", () => {
  it("recognises GitHub's two personal token shapes and nothing else", () => {
    expect(personalTokenKind(`github_pat_${"A".repeat(22)}_${"b".repeat(59)}`)).toBe(
      "fine_grained",
    );
    expect(personalTokenKind(`ghp_${"x".repeat(36)}`)).toBe("classic");
    // OAuth, server-to-server and user-to-server tokens are not personal tokens.
    for (const other of [
      `gho_${"x".repeat(36)}`,
      `ghs_${"x".repeat(36)}`,
      `ghu_${"x".repeat(36)}`,
      `ghr_${"x".repeat(36)}`,
      "ghp_short",
      "github_pat_",
      `github_pat_${"A".repeat(10)} ${"b".repeat(30)}`,
      `ghp_${"x".repeat(600)}`,
      "",
      42,
      null,
      undefined,
      { token: `ghp_${"x".repeat(36)}` },
    ]) {
      expect(personalTokenKind(other), String(other)).toBeNull();
    }
  });
});

describe("tokenWarnings", () => {
  it("warns about classic tokens, tokens without an expiry and tokens about to expire", () => {
    expect(
      tokenWarnings({ kind: "fine_grained", expiresAt: new Date(NOW.getTime() + 60 * DAY) }, NOW),
    ).toEqual([]);
    expect(tokenWarnings({ kind: "classic", expiresAt: null }, NOW)).toEqual([
      "classic_token",
      "no_expiry",
    ]);
    expect(
      tokenWarnings(
        {
          kind: "fine_grained",
          expiresAt: new Date(NOW.getTime() + (TOKEN_EXPIRES_SOON_DAYS - 1) * DAY),
        },
        NOW,
      ),
    ).toEqual(["expires_soon"]);
    // Already expired counts as expiring soon (the page says "replace it").
    expect(
      tokenWarnings({ kind: "fine_grained", expiresAt: new Date(NOW.getTime() - DAY) }, NOW),
    ).toEqual(["expires_soon"]);
  });
});

describe("the connection schemas", () => {
  const token = {
    login: "alice",
    forgeUserId: 1001,
    kind: "fine_grained" as const,
    expiresAt: "2027-01-01T00:00:00.000Z",
    savedAt: "2026-11-11T10:00:00.000Z",
    warnings: [],
  };

  it("describe a token without its value: an unknown field is refused", () => {
    expect(
      ConnectionResponse.safeParse({
        connection: "token",
        token,
        repositories: [],
        lastSyncedAt: null,
        analysisAuto: false,
      }).success,
    ).toBe(true);
    expect(
      ConnectionResponse.safeParse({
        connection: "token",
        token: { ...token, value: "ghp_x" },
        repositories: [],
        lastSyncedAt: null,
        analysisAuto: false,
      }).success,
    ).toBe(false);
    expect(
      ConnectionResponse.safeParse({
        connection: "app",
        token: null,
        repositories: [],
        lastSyncedAt: null,
        analysisAuto: false,
      }).success,
    ).toBe(false);
  });

  it("bound the token request and name repositories by validated owner and name", () => {
    expect(SaveTokenRequest.safeParse({ token: "ghp_x" }).success).toBe(true);
    expect(SaveTokenRequest.safeParse({ token: "x".repeat(513) }).success).toBe(false);
    expect(SaveTokenRequest.safeParse({ token: "", kind: "classic" }).success).toBe(false);
    const repository = {
      id: "0fd9c2a0-5e1f-4b1e-9f3a-8d7c6b5a4e3d",
      forgeRepoId: 77,
      owner: "acme",
      name: "api",
      private: true,
      openPullRequests: 2,
      lastSyncedAt: null,
    };
    const sync = { outcome: "synced", retryAt: null, syncedAt: token.savedAt, repositories: [] };
    expect(AddRepositoryResponse.safeParse({ repository, sync }).success).toBe(true);
    expect(
      AddRepositoryResponse.safeParse({ repository: { ...repository, name: "../etc" }, sync })
        .success,
    ).toBe(false);
    expect(SyncResponse.safeParse({ ...sync, outcome: "<b>" }).success).toBe(false);
  });

  it("the inbox answer carries the sync state only in token mode, as fixed codes", () => {
    expect(InboxResponse.safeParse({ items: [], truncated: false }).success).toBe(true);
    const sync = { state: "synced", lastSyncedAt: null, problem: null, retryAt: null };
    expect(InboxResponse.safeParse({ items: [], truncated: false, sync }).success).toBe(true);
    expect(
      InboxResponse.safeParse({
        items: [],
        truncated: false,
        sync: { ...sync, state: "failed", problem: "rate_limited", retryAt: token.savedAt },
      }).success,
    ).toBe(true);
    // A failure names its problem by code; a success has none; free text never passes.
    for (const bad of [
      { ...sync, state: "failed" },
      { ...sync, problem: "rate_limited" },
      { ...sync, state: "failed", problem: "Rate limit exceeded" },
      { ...sync, state: "pending" },
    ]) {
      expect(InboxSync.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuse with a fixed code and an optional reset time only", () => {
    expect(
      ConnectionErrorResponse.safeParse({ error: "rate_limited", retryAt: token.savedAt }).success,
    ).toBe(true);
    expect(
      ConnectionErrorResponse.safeParse({ error: "token_rejected", retryAt: null }).success,
    ).toBe(true);
    expect(
      ConnectionErrorResponse.safeParse({ error: "Bad credentials", retryAt: null }).success,
    ).toBe(false);
    expect(
      ConnectionErrorResponse.safeParse({ error: "forbidden", retryAt: null, token: "ghp_x" })
        .success,
    ).toBe(false);
  });
});

describe("ForgeReadError.rate_limited", () => {
  it("is transient, has a fixed code and carries only the reset time", () => {
    const error = new ForgeReadError("rate_limited", 403, { retryAt: NOW });
    expect(error.transient).toBe(true);
    expect(error.code).toBe("forge_rate_limited");
    expect(error.retryAt).toBe(NOW);
    expect(error.message).toBe("forge read failed: rate_limited 403");
    expect(new ForgeReadError("network").retryAt).toBeUndefined();
  });
});
