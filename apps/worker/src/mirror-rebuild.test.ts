import type { ClaimedDelivery, Db } from "@rocky-reviews/db";
import { createLogger } from "@rocky-reviews/log";
import { describe, expect, it } from "vitest";
import { drainPullRequestEvents } from "./inbox.js";
import { parseRebuildArgs, REBUILD_DEFAULT_LIMIT, REBUILD_MAX_LIMIT } from "./mirror-rebuild.js";

/** P3-4: the rebuild command's arguments and the pull request lane's refusals (no database). */

describe("parseRebuildArgs", () => {
  it("takes owner/name and an optional limit", () => {
    expect(parseRebuildArgs(["acme/api"])).toEqual({
      fullName: "acme/api",
      limit: REBUILD_DEFAULT_LIMIT,
    });
    expect(parseRebuildArgs(["--", "acme/api", "--limit", "25"])).toEqual({
      fullName: "acme/api",
      limit: 25,
    });
    expect(parseRebuildArgs(["--limit", String(REBUILD_MAX_LIMIT), "acme/api.js"])).toMatchObject({
      limit: REBUILD_MAX_LIMIT,
    });
  });

  it("refuses anything else with the usage line", () => {
    for (const argv of [
      [],
      ["acme"],
      ["acme/api", "acme/web"],
      ["acme/api", "--limit"],
      ["acme/api", "--limit", "0"],
      ["acme/api", "--limit", "-1"],
      ["acme/api", "--limit", String(REBUILD_MAX_LIMIT + 1)],
      ["acme/api", "--force"],
      ["../etc/passwd"],
    ]) {
      expect(() => parseRebuildArgs(argv), argv.join(" ")).toThrow(/^usage: pnpm mirror:rebuild/);
    }
  });
});

describe("the pull request lane", () => {
  const row = (eventType: string, event: unknown): ClaimedDelivery => ({
    forge: "github",
    deliveryId: "00000000-0000-4000-8000-000000000001",
    leaseToken: "00000000-0000-4000-8000-000000000002",
    eventType,
    installationId: 1,
    event,
    attempts: 1,
    strikes: 0,
    leaseUntil: new Date(Date.now() + 600_000),
  });

  const run = async (claimed: ClaimedDelivery) => {
    const failures: { error: string; kind: string }[] = [];
    const db = {
      claimWebhookDeliveries: (options: { eventTypes: readonly string[] }) => {
        expect([...options.eventTypes].sort()).toEqual([
          "pull_request.closed",
          "pull_request.opened",
          "pull_request.reopened",
          "pull_request.synchronize",
        ]);
        return Promise.resolve([claimed]);
      },
      failWebhookDelivery: (_: unknown, failure: { error: string; kind: string }) => {
        failures.push(failure);
        return Promise.resolve("parked" as const);
      },
    } as unknown as Db;
    const report = await drainPullRequestEvents({
      db,
      forge: {
        kind: "github",
        getInstallation: () => Promise.reject(new Error("must not be called")),
        verifyApp: () => Promise.resolve(),
        openRepository: () => Promise.reject(new Error("must not be called")),
        locateRepository: () => Promise.reject(new Error("must not be called")),
        isCollaborator: () => Promise.reject(new Error("must not be called")),
      },
      appCheck: { ready: () => Promise.resolve(true) },
      log: createLogger("lane-test", { destination: { write: () => undefined } }),
    });
    return { report, failures };
  };

  it("parks a decodable row of a type the lane does not handle instead of stalling behind it", async () => {
    const { report, failures } = await run(
      row("installation.created", {
        type: "installation.created",
        installationId: 1,
        account: { id: 2, login: "acme", kind: "organization" },
        sender: null,
      }),
    );
    expect(report).toMatchObject({ claimed: 1, parked: 1 });
    expect(failures).toEqual([
      { error: "unhandled_event_type", retryAfterSeconds: 0, kind: "permanent" },
    ]);
  });

  it("parks a row that does not decode, before any forge call", async () => {
    const { failures } = await run(row("pull_request.opened", { type: "pull_request.opened" }));
    expect(failures).toEqual([{ error: "invalid_event", retryAfterSeconds: 0, kind: "permanent" }]);
  });
});
