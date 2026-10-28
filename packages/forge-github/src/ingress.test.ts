import type { WebhookReceipt, WebhookRequest } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { createGitHubWebhookIngress } from "./ingress.js";
import { payloadSha256, signWebhookBody } from "./signature.js";
import {
  installationPayload,
  organizationPayload,
  PLANTED,
  pullRequestPayload,
  signedDelivery,
  TEST_APP_ID,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  type SignedDelivery,
} from "./testing.js";

const ingress = createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET });
const receive = (delivery: SignedDelivery): WebhookReceipt =>
  ingress.receive(webhookRequest(delivery));

/** Overrides headers; `undefined` removes one. */
const withHeaders = (d: SignedDelivery, headers: Record<string, string | undefined>) => {
  const merged = Object.entries({ ...d.headers, ...headers }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return { ...d, headers: Object.fromEntries(merged) };
};

/** Same headers, new body, correctly re-signed. */
const resigned = (d: SignedDelivery, body: Buffer): SignedDelivery => ({
  body,
  headers: { ...d.headers, "x-hub-signature-256": signWebhookBody(TEST_WEBHOOK_SECRET, body) },
});

describe("authentication comes first", () => {
  it("rejects an unsigned request whatever else it carries, without looking further", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    for (const variant of [
      withHeaders(d, { "x-hub-signature-256": undefined }),
      withHeaders(d, { "x-hub-signature-256": "sha256=" + "0".repeat(64) }),
      // Garbage everywhere else too: the answer is still "unauthenticated", not "bad headers".
      withHeaders(
        { ...d, body: Buffer.from("not json") },
        {
          "x-hub-signature-256": undefined,
          "x-github-delivery": "x",
          "content-type": "text/plain",
        },
      ),
    ]) {
      expect(receive(variant)).toEqual({ outcome: "rejected", reason: "unauthenticated" });
    }
  });

  it("rejects a signature made with another secret", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"), {
      secret: `${TEST_WEBHOOK_SECRET}-other`,
    });
    expect(receive(d)).toEqual({ outcome: "rejected", reason: "unauthenticated" });
  });

  it("treats a header accessor that throws as unauthenticated (never throws itself)", () => {
    const request: WebhookRequest = {
      body: Buffer.from("{}"),
      header: () => {
        throw new Error("boom");
      },
    };
    expect(ingress.receive(request)).toEqual({ outcome: "rejected", reason: "unauthenticated" });
  });

  it("cannot be built without a usable secret", () => {
    expect(() => createGitHubWebhookIngress({ secret: "" })).toThrow(/at least 32/);
  });
});

describe("after authentication", () => {
  it("requires a GUID delivery id and a well-formed event name", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    for (const headers of [
      { "x-github-delivery": undefined },
      { "x-github-delivery": "" },
      { "x-github-delivery": "not-a-guid" },
      { "x-github-delivery": `${d.headers["x-github-delivery"]}0` },
      { "x-github-event": undefined },
      { "x-github-event": "Pull_Request" },
      { "x-github-event": "pull_request\nx" },
      { "x-github-event": "a".repeat(65) },
    ]) {
      expect(receive(withHeaders(d, headers)), JSON.stringify(headers)).toEqual({
        outcome: "rejected",
        reason: "bad_headers",
      });
    }
  });

  it("normalises the delivery id to lower case", () => {
    const id = "72D3162E-CC78-11E3-81AB-4C9367DC0958";
    const r = receive(
      signedDelivery("pull_request", pullRequestPayload("opened"), { deliveryId: id }),
    );
    expect(r.outcome === "accepted" && r.delivery.deliveryId).toBe(id.toLowerCase());
  });

  it("accepts only JSON bodies", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    for (const type of [undefined, "application/x-www-form-urlencoded", "text/json", "json"]) {
      expect(receive(withHeaders(d, { "content-type": type })), String(type)).toEqual({
        outcome: "rejected",
        reason: "unsupported_media_type",
      });
    }
    expect(
      receive(withHeaders(d, { "content-type": "application/json; charset=utf-8" })).outcome,
    ).toBe("accepted");
  });

  it("acknowledges unknown events without parsing the body", () => {
    const d = resigned(signedDelivery("issues", {}), Buffer.from("{ not json"));
    expect(receive(d)).toEqual({
      outcome: "ignored",
      deliveryId: d.headers["x-github-delivery"],
      eventName: "issues",
    });
  });

  it("answers ping", () => {
    const d = signedDelivery("ping", { zen: "Keep it logically awesome.", hook_id: 1 });
    expect(receive(d)).toEqual({ outcome: "ping", deliveryId: d.headers["x-github-delivery"] });
  });

  it("refuses bodies that are not UTF-8 JSON", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    for (const body of [
      Buffer.from(""),
      Buffer.from("{"),
      Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
      Buffer.from("[".repeat(200_000)),
    ]) {
      expect(receive(resigned(d, body))).toEqual({ outcome: "rejected", reason: "bad_payload" });
    }
  });
});

describe("installation events", () => {
  it.each(["created", "deleted"])(
    "decodes installation.%s to ids, logins, account kind and the installer only",
    (action) => {
      const d = signedDelivery("installation", installationPayload(action));
      const r = receive(d);
      expect(r).toEqual({
        outcome: "accepted",
        delivery: {
          forge: "github",
          deliveryId: d.headers["x-github-delivery"],
          payloadSha256: payloadSha256(d.body),
          event: {
            type: `installation.${action}`,
            installationId: 4242,
            account: { id: 9001, login: "acme", kind: "organization" },
            sender: { id: 5, login: "alice" },
          },
        },
      });
      const serialised = JSON.stringify(r);
      // The installer's login is kept on purpose (P3-3); their email and type are not.
      for (const planted of [PLANTED.email, "html_url", "permissions", '"User"', "acme/api"]) {
        expect(serialised).not.toContain(planted);
      }
    },
  );

  it("maps a user account", () => {
    const r = receive(
      signedDelivery("installation", installationPayload("created", { type: "User" })),
    );
    expect(r.outcome === "accepted" && r.delivery.event).toMatchObject({
      account: { kind: "user" },
    });
  });

  it("ignores actions the domain does not consume", () => {
    for (const action of [
      "suspend",
      "unsuspend",
      "new_permissions_accepted",
      "CREATED",
      "__proto__",
    ]) {
      expect(
        receive(signedDelivery("installation", installationPayload(action))).outcome,
        action,
      ).toBe("ignored");
    }
  });

  it("acknowledges and ignores an account type the domain does not model, with a reason code", () => {
    for (const type of ["Enterprise", "Bot", "organization", "", "X".repeat(10_000)]) {
      const d = signedDelivery("installation", installationPayload("created", { type }));
      expect(receive(d), type).toEqual({
        outcome: "ignored",
        deliveryId: d.headers["x-github-delivery"],
        eventName: "installation",
        reason: "unsupported_account_type",
      });
    }
  });

  it("accepts an installer that is a GitHub App acting as itself (name[bot])", () => {
    for (const action of ["created", "deleted"]) {
      const payload = {
        ...installationPayload(action),
        sender: { id: 7, login: "rocky-reviews[bot]" },
      };
      const r = receive(signedDelivery("installation", payload));
      expect(r.outcome === "accepted" && r.delivery.event, action).toMatchObject({
        sender: { id: 7, login: "rocky-reviews[bot]" },
      });
    }
  });

  it("never loses an installation change over an unusable sender: it becomes null (review round 2, B1)", () => {
    for (const action of ["created", "deleted"]) {
      for (const sender of [
        undefined,
        null,
        "ghost",
        { id: 0, login: "alice" },
        { id: 5, login: "alice smith" },
        { id: 5, login: "a".repeat(101) },
        { id: 5, login: "[bot]" },
        { id: 5, login: "x[bot][bot]" },
        { login: "staff" },
      ]) {
        const payload = { ...installationPayload(action), sender };
        const r = receive(signedDelivery("installation", payload));
        expect(r.outcome, `${action} ${JSON.stringify(sender)}`).toBe("accepted");
        expect(r.outcome === "accepted" && r.delivery.event).toMatchObject({ sender: null });
      }
    }
  });

  it("refuses a known action with the wrong shape", () => {
    for (const payload of [
      installationPayload("created", { login: "acme corp" }),
      installationPayload("created", { type: 7 as unknown as string }),
      installationPayload("created", { login: "a".repeat(101) }),
      installationPayload("created", { installationId: 0 }),
      installationPayload("created", { installationId: -1 }),
      installationPayload("created", { installationId: 1.5 }),
      installationPayload("created", { installationId: 2 ** 53 }),
      { action: "created" },
      {
        action: "created",
        installation: { id: "4242", account: { id: 1, login: "a", type: "User" } },
      },
      { action: 1 },
      [],
      null,
      "created",
    ]) {
      expect(receive(signedDelivery("installation", payload)), JSON.stringify(payload)).toEqual({
        outcome: "rejected",
        reason: "bad_payload",
      });
    }
  });
});

describe("pull request events", () => {
  it.each(["opened", "synchronize", "closed", "reopened"])(
    "decodes pull_request.%s to ids, number and head sha only",
    (action) => {
      const r = receive(signedDelivery("pull_request", pullRequestPayload(action)));
      expect(r.outcome === "accepted" && r.delivery.event).toEqual({
        type: `pull_request.${action}`,
        installationId: 4242,
        repositoryId: 77,
        number: 847,
        headSha: "a".repeat(40),
        merged: false,
      });
      const serialised = JSON.stringify(r);
      for (const planted of [
        PLANTED.title,
        PLANTED.body,
        PLANTED.email,
        "acme/api",
        "feature/invite",
      ]) {
        expect(serialised).not.toContain(planted);
      }
    },
  );

  it("reports merged only for a merged close", () => {
    const merged = receive(
      signedDelivery("pull_request", pullRequestPayload("closed", { merged: true })),
    );
    expect(merged.outcome === "accepted" && merged.delivery.event).toMatchObject({ merged: true });
    const reopened = receive(
      signedDelivery("pull_request", pullRequestPayload("reopened", { merged: true })),
    );
    expect(reopened.outcome === "accepted" && reopened.delivery.event).toMatchObject({
      merged: false,
    });
    const nullMerged = receive(
      signedDelivery("pull_request", pullRequestPayload("closed", { merged: null })),
    );
    expect(nullMerged.outcome === "accepted" && nullMerged.delivery.event).toMatchObject({
      merged: false,
    });
  });

  it("accepts SHA-256 object ids", () => {
    const r = receive(
      signedDelivery(
        "pull_request",
        pullRequestPayload("synchronize", { headSha: "c".repeat(64) }),
      ),
    );
    expect(r.outcome).toBe("accepted");
  });

  it("ignores other actions", () => {
    for (const action of [
      "labeled",
      "edited",
      "review_requested",
      "ready_for_review",
      "constructor",
    ]) {
      expect(
        receive(signedDelivery("pull_request", pullRequestPayload(action))).outcome,
        action,
      ).toBe("ignored");
    }
  });

  it("refuses a known action with the wrong shape", () => {
    const base = pullRequestPayload("opened");
    for (const payload of [
      pullRequestPayload("opened", { headSha: "A".repeat(40) }),
      pullRequestPayload("opened", { headSha: "a".repeat(39) }),
      pullRequestPayload("opened", { number: 0 }),
      pullRequestPayload("opened", { number: 2 ** 31 }),
      pullRequestPayload("opened", { repositoryId: -3 }),
      { ...base, number: 1 }, // top-level number disagrees with pull_request.number
      { ...base, installation: undefined }, // repository webhook, not an App delivery
      { ...base, repository: null },
      { ...base, pull_request: { number: 847 } },
    ]) {
      expect(receive(signedDelivery("pull_request", payload)), JSON.stringify(payload)).toEqual({
        outcome: "rejected",
        reason: "bad_payload",
      });
    }
  });

  it("refuses a pull request body replayed under the installation event name (unsigned header swap)", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("closed"));
    const swapped = withHeaders(d, { "x-github-event": "installation" });
    expect(receive(swapped).outcome).not.toBe("accepted");
    const opened = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect(receive(withHeaders(opened, { "x-github-event": "installation" })).outcome).toBe(
      "ignored",
    );
  });

  it("does not let __proto__ keys in the payload pollute prototypes", () => {
    const raw = Buffer.from(
      JSON.stringify(pullRequestPayload("opened")).replace(
        '"action"',
        '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"action"',
      ),
    );
    const r = receive(resigned(signedDelivery("pull_request", {}), raw));
    expect(r.outcome).toBe("accepted");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("precheck (headers only, before the body is read)", () => {
  const headerOf = (headers: Record<string, string>) => (name: string) =>
    Object.hasOwn(headers, name) ? headers[name] : undefined;

  it("refuses a missing or malformed signature header, and bad delivery/event/media headers", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const cases: [Record<string, string | undefined>, string | undefined][] = [
      [{}, undefined],
      [{ "x-hub-signature-256": undefined }, "unauthenticated"],
      [{ "x-hub-signature-256": "sha256=xyz" }, "unauthenticated"],
      [{ "x-hub-signature-256": "sha1=" + "0".repeat(40) }, "unauthenticated"],
      // Well formed but wrong: precheck holds no secret, so receive() decides.
      [{ "x-hub-signature-256": "sha256=" + "0".repeat(64) }, undefined],
      [{ "x-github-delivery": "nope" }, "bad_headers"],
      [{ "x-github-event": "Bad" }, "bad_headers"],
      [{ "content-type": "text/plain" }, "unsupported_media_type"],
    ];
    for (const [override, expected] of cases) {
      const headers = withHeaders(d, override).headers;
      expect(ingress.precheck(headerOf(headers)), JSON.stringify(override)).toBe(expected);
    }
  });

  it("treats a throwing header accessor as unauthenticated", () => {
    expect(
      ingress.precheck(() => {
        throw new Error("boom");
      }),
    ).toBe("unauthenticated");
  });

  it("never lets through what receive would refuse: same reason when signed, else unauthenticated", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const variants = [
      undefined,
      "",
      "nope",
      "sha256=" + "0".repeat(64),
      d.headers["x-hub-signature-256"],
    ];
    for (const signature of variants) {
      for (const delivery of [undefined, "x", d.headers["x-github-delivery"]]) {
        for (const event of [undefined, "Bad", "pull_request", "issues"]) {
          for (const type of [undefined, "text/plain", "application/json"]) {
            const headers = withHeaders(d, {
              "x-hub-signature-256": signature,
              "x-github-delivery": delivery,
              "x-github-event": event,
              "content-type": type,
            }).headers;
            const pre = ingress.precheck(headerOf(headers));
            if (pre === undefined) continue;
            // precheck holds no secret: with a genuine signature receive gives the same reason;
            // with a forged one receive says "unauthenticated". Either way it is refused.
            const genuine = signature === d.headers["x-hub-signature-256"];
            expect(receive({ ...d, headers })).toEqual({
              outcome: "rejected",
              reason: genuine ? pre : pre === "unauthenticated" ? pre : "unauthenticated",
            });
          }
        }
      }
    }
  });
});

describe("organization events (P7-2, ADR 0024)", () => {
  it("decodes member_removed to the organization, the installation and the person's id only", () => {
    const d = signedDelivery("organization", organizationPayload("member_removed"));
    const r = receive(d);
    expect(r).toEqual({
      outcome: "accepted",
      delivery: {
        forge: "github",
        deliveryId: d.headers["x-github-delivery"],
        payloadSha256: payloadSha256(d.body),
        event: {
          type: "org_member.removed",
          installationId: 4242,
          account: { id: 9001, login: "acme", kind: "organization" },
          memberForgeUserId: 9101,
        },
      },
    });
    const serialised = JSON.stringify(r);
    for (const planted of [PLANTED.email, PLANTED.title, "octo-dev", "node_id", "memberships"]) {
      expect(serialised).not.toContain(planted);
    }
  });

  it("ignores every other organization action: nothing is ever granted from a webhook", () => {
    for (const action of [
      "member_added",
      "member_invited",
      "renamed",
      "deleted",
      "MEMBER_REMOVED",
      "__proto__",
    ]) {
      expect(receive(signedDelivery("organization", organizationPayload(action))).outcome).toBe(
        "ignored",
      );
    }
  });

  it("ignores team membership events: leaving a team is not leaving the organization", () => {
    const d = signedDelivery("membership", { ...organizationPayload("removed"), scope: "team" });
    expect(receive(d)).toEqual({
      outcome: "ignored",
      deliveryId: d.headers["x-github-delivery"],
      eventName: "membership",
    });
  });

  it("refuses a member_removed payload without usable ids", () => {
    const base = organizationPayload("member_removed");
    for (const payload of [
      { ...base, membership: { user: { id: 0 } } },
      { ...base, membership: { user: { id: "9101" } } },
      { ...base, membership: null },
      { ...base, organization: { id: 9001, login: "../etc" } },
      { ...base, organization: { id: -1, login: "acme" } },
      { ...base, installation: undefined },
    ]) {
      expect(receive(signedDelivery("organization", payload))).toEqual({
        outcome: "rejected",
        reason: "bad_payload",
      });
    }
  });
});

describe("claimsOwnSender (rate-limit bucketing only, P7-3)", () => {
  const ours = createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET, appId: TEST_APP_ID });
  const claims = (i: typeof ours, d: SignedDelivery) =>
    i.claimsOwnSender?.((name) => d.headers[name]) ?? false;

  it("true only for GitHub's hook target headers naming this app", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect(claims(ours, d)).toBe(true);
    for (const target of [
      { type: "integration", id: String(TEST_APP_ID + 1) },
      // A repository whose id happens to equal the app id is another hook.
      { type: "repository", id: String(TEST_APP_ID) },
      { type: "integration", id: ` ${TEST_APP_ID}` },
    ]) {
      const other = signedDelivery("pull_request", pullRequestPayload("opened"), {
        hookTarget: target,
      });
      expect(claims(ours, other), JSON.stringify(target)).toBe(false);
    }
    expect(
      claims(ours, withHeaders(d, { "x-github-hook-installation-target-id": undefined })),
    ).toBe(false);
  });

  it("without an app id nothing is ours, and a throwing header lookup is false", () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect(claims(ingress, d)).toBe(false);
    expect(
      ours.claimsOwnSender?.(() => {
        throw new Error("boom");
      }),
    ).toBe(false);
  });
});
