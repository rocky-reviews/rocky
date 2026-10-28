import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineText } from "./inline-text.js";

const render = (text: string) => renderToStaticMarkup(<InlineText text={text} />);

describe("InlineText", () => {
  it("renders **bold** and `code` as elements and the rest as text", () => {
    expect(render("Adds **email invitations** with `zod 4.6.6`.")).toBe(
      "<bdi>Adds <strong>email invitations</strong> with <code>zod 4.6.6</code>.</bdi>",
    );
  });

  it("never turns model output into markup", () => {
    const html = render("<img src=x onerror=alert(1)> **<b>x</b>** `<script>` [a](javascript:1)");
    expect(html).not.toMatch(/<img|<script|<b>|<a\b|href=/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
    expect(html).toContain("<code>&lt;script&gt;</code>");
  });

  it("leaves unbalanced markers as they are", () => {
    expect(render("a ** b ` c")).toBe("<bdi>a ** b ` c</bdi>");
  });

  it("keeps bidi controls inside the isolate", () => {
    expect(render("‮evil")).toBe("<bdi>‮evil</bdi>");
  });
});
