import { describe, expect, it } from "vitest";
import { pullRequestUrl } from "./github-url.js";

describe("pullRequestUrl", () => {
  it("builds the PR link from owner, repo and number", () => {
    expect(pullRequestUrl({ owner: "acme", repo: "rocky-app", number: 847 })).toBe(
      "https://github.com/acme/rocky-app/pull/847",
    );
    expect(pullRequestUrl({ owner: "a-b", repo: "x.y_z", number: 1 })).toBe(
      "https://github.com/a-b/x.y_z/pull/1",
    );
  });

  it.each([
    ["an owner with a slash", { owner: "evil.com/acme", repo: "app", number: 1 }],
    ["an owner with a scheme", { owner: "javascript:alert(1)", repo: "app", number: 1 }],
    ["an owner with spaces", { owner: "a b", repo: "app", number: 1 }],
    ["an empty owner", { owner: "", repo: "app", number: 1 }],
    ["an owner with @", { owner: "user@evil.com", repo: "app", number: 1 }],
    ["a repo that walks up", { owner: "acme", repo: "..", number: 1 }],
    ["a repo that is a dot", { owner: "acme", repo: ".", number: 1 }],
    ["a repo with a slash", { owner: "acme", repo: "app/../../x", number: 1 }],
    ["a repo with a query", { owner: "acme", repo: "app?x=1", number: 1 }],
    ["a repo with a fragment", { owner: "acme", repo: "app#x", number: 1 }],
    ["number 0", { owner: "acme", repo: "app", number: 0 }],
    ["a negative number", { owner: "acme", repo: "app", number: -3 }],
    ["a fractional number", { owner: "acme", repo: "app", number: 1.5 }],
    ["NaN", { owner: "acme", repo: "app", number: Number.NaN }],
    ["a huge number", { owner: "acme", repo: "app", number: 1e20 }],
  ])("refuses %s", (_name, ref) => {
    expect(pullRequestUrl(ref)).toBeUndefined();
  });

  it("refuses values that are not strings or numbers at all", () => {
    const ref = { owner: 1, repo: null, number: "847" } as unknown as Parameters<
      typeof pullRequestUrl
    >[0];
    expect(pullRequestUrl(ref)).toBeUndefined();
  });

  it("always points at github.com over https", () => {
    const url = new URL(pullRequestUrl({ owner: "acme", repo: "rocky-app", number: 9 }) ?? "");
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("github.com");
  });
});
