import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@rocky-reviews/db";
import { CONTAINER_TIMEOUT_MS, startPostgres, type TestPostgres } from "@rocky-reviews/db/testing";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import {
  installationPayload,
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
  type SignedDelivery,
} from "@rocky-reviews/forge-github/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/**
 * P3-2 end to end: HTTP → signature → decode → app.webhook_deliveries, against a real Postgres
 * as the application role. "Same delivery twice → one job" is decided by the database, so it
 * holds across server instances and under concurrent duplicates.
 */

let pgs: TestPostgres;
let db: Db;
let superuser: pg.Pool;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 10 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 });
  app = buildApp({
    checkDatabase: () => Promise.resolve(true),
    webhooks: {
      ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
      inbox: { record: (d) => db.recordWebhookDelivery(d) },
    },
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

const post = (d: SignedDelivery) =>
  app.inject({ method: "POST", url: "/webhooks/github", headers: d.headers, payload: d.body });

const stored = async (deliveryId: string) =>
  (
    await superuser.query<{ event: unknown }>(
      "select event from app.webhook_deliveries where delivery_id = $1",
      [deliveryId],
    )
  ).rows;

describe("webhook receiver with the database inbox", () => {
  it("same delivery twice → one job", async () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect((await post(d)).statusCode).toBe(202);
    expect((await post(d)).statusCode).toBe(200);
    expect(await stored(d.headers["x-github-delivery"]!)).toEqual([
      {
        event: {
          type: "pull_request.opened",
          installationId: 4242,
          repositoryId: 77,
          number: 847,
          headSha: "a".repeat(40),
          merged: false,
        },
      },
    ]);
  });

  it("concurrent duplicates (GitHub retry racing the original) → exactly one job", async () => {
    const d = signedDelivery(
      "installation",
      installationPayload("created", { installationId: 99 }),
    );
    const responses = await Promise.all(Array.from({ length: 30 }, () => post(d)));
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 202)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(29);
    expect(await stored(d.headers["x-github-delivery"]!)).toHaveLength(1);
  });

  it("concurrent replays of one signed body under fresh delivery ids → exactly one job", async () => {
    const d = signedDelivery("pull_request", pullRequestPayload("closed", { number: 9 }));
    const replays = Array.from({ length: 15 }, () => ({
      ...d,
      headers: { ...d.headers, "x-github-delivery": randomUUID() },
    }));
    const responses = await Promise.all(replays.map(post));
    expect(responses.filter((r) => r.statusCode === 202)).toHaveLength(1);
    const { rows } = await superuser.query(
      "select 1 from app.webhook_deliveries where event ->> 'number' = '9'",
    );
    expect(rows).toHaveLength(1);
  });

  it("a forged delivery stores nothing", async () => {
    const d = signedDelivery("installation", installationPayload("deleted"), {
      secret: "attacker-guess".padEnd(40, "x"), // built at runtime: not a real secret
    });
    expect((await post(d)).statusCode).toBe(401);
    expect(await stored(d.headers["x-github-delivery"]!)).toEqual([]);
  });
});
