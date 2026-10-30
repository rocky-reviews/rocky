import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadProblem } from "./App.js";

const render = (...args: Parameters<typeof LoadProblem>) =>
  renderToStaticMarkup(<LoadProblem {...args[0]} />);

describe("the PR page before it can show the PR (H4-2)", () => {
  it("loading is a polite status", () => {
    expect(render({ state: { kind: "loading" } })).toContain('<p role="status">Loading…</p>');
  });

  it("signed out: a sign-in link that comes back to this PR", () => {
    const html = render({
      state: { kind: "failed", reason: "signed_out" },
      returnTo: "/acme/rocky-app/pull/847",
    });
    expect(html).toContain(
      'href="/auth/github/login?returnTo=%2Facme%2Frocky-app%2Fpull%2F847">Sign in with GitHub</a>',
    );
  });

  it("signed out with no safe path to return to: a plain sign-in link", () => {
    expect(
      render({ state: { kind: "failed", reason: "signed_out" }, returnTo: "//evil.example" }),
    ).toContain('href="/auth/github/login"');
  });

  it("not found, access not available yet and other failures are alerts with fixed text", () => {
    const notFound = render({ state: { kind: "failed", reason: "not_found" } });
    expect(notFound).toContain('role="alert"');
    expect(notFound).toContain("This pull request isn’t in Rocky");
    expect(notFound).toContain('<a href="/inbox">Go to your inbox</a>');
    expect(render({ state: { kind: "failed", reason: "unavailable" } })).toContain(
      "Repository access isn’t available yet",
    );
    expect(render({ state: { kind: "failed", reason: "failed" } })).toContain(
      "This pull request could not be loaded.",
    );
  });

  it("every state is the page's one main landmark", () => {
    for (const reason of ["signed_out", "not_found", "unavailable", "failed"] as const) {
      const html = render({ state: { kind: "failed", reason } });
      expect(html.match(/<main class="status-page" id="main">/g)).toHaveLength(1);
    }
  });
});
