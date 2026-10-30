import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Author, authorInitials, authorName, LoginContext } from "./Author.js";

const render = (login: string | null) =>
  renderToStaticMarkup(
    <LoginContext value={login}>
      <Author />
    </LoginContext>,
  );

describe("Author (P6-9)", () => {
  it("names the reviewer by their GitHub login, as GitHub will show the comment", () => {
    expect(render("dana-k")).toBe(
      '<span class="avatar" aria-hidden="true">DA</span><b><bdi>@dana-k</bdi></b>',
    );
  });

  it('says "you" until the session has loaded', () => {
    expect(render(null)).toBe(
      '<span class="avatar" aria-hidden="true">Y</span><b><bdi>you</bdi></b>',
    );
  });

  it("renders the login as text", () => {
    expect(render("<img src=x>")).not.toContain("<img");
    expect(authorName("a")).toBe("@a");
    expect(authorInitials("-x")).toBe("X");
    expect(authorInitials("--")).toBe("Y");
  });
});
