import type { WebhookReceipt } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { createGitHubWebhookIngress } from "./ingress.js";
import {
  PLANTED,
  pushPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  type SignedDelivery,
} from "./testing.js";

/**
 * P9-1 (ADR 0040 §4): `push` deliveries become `repository.push` events for the default branch
 * only, carrying ids and the new head; nothing of the commits (messages, authors, emails, file
 * lists) is kept.
 */

const ingress = createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET });
const receive = (delivery: SignedDelivery): WebhookReceipt =>
  ingress.receive(webhookRequest(delivery));

describe("push events", () => {
  it("decodes a push to the default branch to ids and the new head", () => {
    const receipt = receive(signedDelivery("push", pushPayload({ after: "d".repeat(40) })));
    expect(receipt.outcome).toBe("accepted");
    if (receipt.outcome !== "accepted") return;
    expect(receipt.delivery.event).toEqual({
      type: "repository.push",
      installationId: 4242,
      repositoryId: 77,
      headSha: "d".repeat(40),
    });
    const kept = JSON.stringify(receipt.delivery.event);
    for (const planted of Object.values(PLANTED)) expect(kept).not.toContain(planted);
  });

  it("ignores pushes to other branches, tags and branch deletions", () => {
    for (const payload of [
      pushPayload({ ref: "refs/heads/feature/x" }),
      pushPayload({ ref: "refs/tags/v1.0.0" }),
      pushPayload({ ref: "refs/heads/develop", defaultBranch: "main" }),
      pushPayload({ deleted: true, after: "0".repeat(40) }),
    ]) {
      expect(receive(signedDelivery("push", payload)).outcome).toBe("ignored");
    }
    // A default branch with another name is still the default branch.
    expect(
      receive(
        signedDelivery("push", pushPayload({ ref: "refs/heads/trunk", defaultBranch: "trunk" })),
      ).outcome,
    ).toBe("accepted");
  });

  it("refuses a push payload of the wrong shape", () => {
    for (const payload of [
      { ...pushPayload(), after: "not-a-sha" },
      { ...pushPayload(), installation: undefined },
      { ...pushPayload(), repository: { id: -1, default_branch: "main" } },
      { ...pushPayload(), ref: 42 },
    ]) {
      expect(receive(signedDelivery("push", payload))).toEqual({
        outcome: "rejected",
        reason: "bad_payload",
      });
    }
  });
});
