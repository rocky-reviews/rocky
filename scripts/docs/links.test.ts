import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorsOf, checkFile, checkRepository, githubSlug, linksOf } from "./links.js";

/** P10-3: the docs build is a link and anchor check over every Markdown file. */

const check = (files: Record<string, string>, file: string, dirs: string[] = []): string[] =>
  checkFile(
    file,
    (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`read ${path}`);
      return text;
    },
    (path) => path in files || dirs.includes(path),
    (path) => dirs.includes(path),
  );

describe("the docs build", () => {
  it("passes on the repository", () => {
    const { files, problems } = checkRepository(fileURLToPath(new URL("../..", import.meta.url)));
    expect(problems).toEqual([]);
    expect(files).toBeGreaterThan(5);
  });

  it("slugs headings as GitHub does", () => {
    expect(githubSlug("How `pnpm db:migrate` works")).toBe("how-pnpm-dbmigrate-works");
    expect(githubSlug("2. Three roles, one owner")).toBe("2-three-roles-one-owner");
    expect(githubSlug("Provisioning (once per cluster)")).toBe("provisioning-once-per-cluster");
    expect(githubSlug("A [link](x.md) and **bold**")).toBe("a-link-and-bold");
    expect(githubSlug("snake_case stays")).toBe("snake_case-stays");
  });

  it("numbers repeated headings and reads explicit anchors, not fenced ones", () => {
    const markdown = ["# Notes", "## Notes", '<a id="here"></a>', "```", "# Hidden", "```"].join(
      "\n",
    );
    expect(anchorsOf(markdown)).toEqual(new Set(["notes", "notes-1", "here"]));
  });

  it("finds inline links, images and definitions outside code", () => {
    const markdown = [
      'See [a](a.md#top) and ![img](img.png "title").',
      "`[not](code.md)`",
      "```",
      "[not](fence.md)",
      "```",
      "[ref]: <b c.md>",
    ].join("\n");
    expect(linksOf(markdown).map((link) => link.target)).toEqual(["a.md#top", "img.png", "b c.md"]);
  });

  it("reports a missing file, a missing anchor and paths it cannot check", () => {
    const files = {
      "docs/a.md": [
        "[ok](b.md#title) [self](#local) [up](../README.md) [dir](sub/)",
        "[web](https://example.com/x.md) [mail](mailto:x@example.com)",
        "[gone](missing.md) [bad](b.md#nope) [root](/docs/b.md) [out](../../x.md)",
        "## Local",
      ].join("\n"),
      "docs/b.md": "# Title\n",
      "README.md": "# Readme\n",
    };
    expect(check(files, "docs/a.md", ["docs/sub"])).toEqual([
      "docs/a.md:3: missing.md: no such file",
      "docs/a.md:3: b.md#nope: no heading or anchor #nope",
      "docs/a.md:3: /docs/b.md: use a path relative to this file",
      "docs/a.md:3: ../../x.md: points outside the repository",
    ]);
  });
});
