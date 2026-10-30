import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PathText } from "./path-text.js";

const render = (path: string) => renderToStaticMarkup(<PathText path={path} />);

describe("PathText (P6-9)", () => {
  it("offers a line break after each slash", () => {
    expect(render("db/migrations/20261020_add_invitations.sql")).toBe(
      "<bdi>db/<wbr/>migrations/<wbr/>20261020_add_invitations.sql</bdi>",
    );
  });

  it("leaves a bare name alone", () => {
    expect(render("pnpm-lock.yaml")).toBe("<bdi>pnpm-lock.yaml</bdi>");
  });

  it("renders the path as text, inside the bidi isolate", () => {
    expect(render("a/<img src=x>/‮b")).toBe("<bdi>a/<wbr/>&lt;img src=x&gt;/<wbr/>‮b</bdi>");
  });
});
