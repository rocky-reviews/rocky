import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import {
  changeTree,
  type ChangeTree,
  initialOpen,
  isTestPath,
  type TreeFolder,
  type TreeSource,
} from "./change-tree-model.js";

type Level = "critical" | "important" | "normal" | "low";
type Spec = [path: string, level: Level | "noise" | "unanalysed", lines: number, added?: boolean];

/** A document's tree inputs from one line per file. */
const source = (specs: readonly Spec[]): TreeSource => ({
  triage: {
    files: specs
      .filter(
        (s): s is [string, Level, number, boolean?] => s[1] !== "noise" && s[1] !== "unanalysed",
      )
      .map(([path, level]) => ({ path, level })),
    noise: specs.filter((s) => s[1] === "noise").map(([path]) => ({ path })),
  },
  provenance: {
    files: specs.map(([path, , lines, added = true]) => ({
      path,
      status: added ? "added" : "modified",
      additions: lines,
      deletions: added ? 0 : 1,
    })),
    unanalysed: specs.filter((s) => s[1] === "unanalysed").map(([path]) => ({ path })),
  },
});

/** The credits-ledger PR of the approved mockup (29 files). */
const LEDGER: Spec[] = [
  [".github/workflows/ci.yml", "normal", 63],
  [".gitignore", "low", 3, false],
  [".gitleaks.toml", "normal", 7],
  [".npmrc", "normal", 3],
  [".nvmrc", "low", 1],
  [".prettierignore", "low", 5],
  [".prettierrc", "low", 3],
  ["README.md", "low", 6, false],
  ["billing/README.md", "normal", 46],
  ["billing/package.json", "normal", 14],
  ["billing/src/index.ts", "normal", 4],
  ["billing/src/ledger.test.ts", "normal", 388],
  ["billing/src/ledger.ts", "important", 290],
  ["billing/src/memory-store.ts", "normal", 90],
  ["billing/src/money.test.ts", "normal", 100],
  ["billing/src/money.ts", "normal", 47],
  ["billing/src/reconcile.test.ts", "normal", 140],
  ["billing/src/reconcile.ts", "important", 165],
  ["docs/adr/0002-consuming-rocky.md", "normal", 36],
  ["docs/adr/0003-credits-ledger.md", "important", 86],
  ["docs/progress.md", "low", 26],
  ["eslint.config.js", "normal", 40],
  ["package.json", "low", 34],
  ["pnpm-lock.yaml", "noise", 1622],
  ["pnpm-workspace.yaml", "normal", 9],
  ["scripts/security/gitleaks.sh", "normal", 66],
  ["tsconfig.base.json", "low", 19],
  ["tsconfig.json", "normal", 4],
  ["vitest.config.ts", "normal", 14],
];

const top = (tree: ChangeTree, name: string): TreeFolder => {
  const found = tree.folders.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no folder ${name}`);
  return found;
};
const names = (folders: readonly TreeFolder[]) => folders.map((f) => f.name);
const paths = (files: readonly { path: string }[]) => files.map((f) => f.path);

describe("changeTree (H4-12)", () => {
  const tree = changeTree(source(LEDGER));

  it("shows only changed folders and collapses single-child folder chains", () => {
    expect(names(tree.folders)).toEqual([
      "billing",
      "docs/adr",
      "scripts/security",
      ".github/workflows",
      "(root config)",
    ]);
    expect(names(top(tree, "billing").folders)).toEqual(["src"]);
    const nested = changeTree(
      source([
        ["a/b/c/x.ts", "critical", 5],
        ["a/b/c/d/y.ts", "normal", 5],
      ]),
    );
    expect(names(nested.folders)).toEqual(["a/b/c"]);
    expect(names(nested.folders[0]?.folders ?? [])).toEqual(["d"]);
    expect(nested.folders[0]?.path).toBe("a/b/c");
    expect(nested.folders[0]?.folders[0]?.path).toBe("a/b/c/d");
  });

  it("puts root-level files in a (root config) folder, last", () => {
    const root = top(tree, "(root config)");
    expect(tree.folders.at(-1)).toBe(root);
    expect(paths([...root.key, ...root.rest]).toSorted()).toEqual(
      [
        ".gitleaks.toml",
        ".npmrc",
        "eslint.config.js",
        "pnpm-workspace.yaml",
        "tsconfig.json",
        "vitest.config.ts",
      ].toSorted(),
    );
  });

  it("keeps low and noise files out of the tree, in one Ignored group", () => {
    expect(paths(tree.ignored.files)).toEqual([
      "pnpm-lock.yaml",
      "package.json",
      "docs/progress.md",
      "tsconfig.base.json",
      "README.md",
      ".prettierignore",
      ".gitignore",
      ".prettierrc",
      ".nvmrc",
    ]);
    expect(tree.ignored.additions).toBe(1719);
    expect(tree.ignored.files.every((f) => f.level === "ignore")).toBe(true);
    const all = (fs: readonly TreeFolder[]): string[] =>
      fs.flatMap((f) => [...paths(f.key), ...paths(f.rest), ...all(f.folders)]);
    expect(all(tree.folders)).not.toContain("pnpm-lock.yaml");
    expect(all(tree.folders)).not.toContain("docs/progress.md");
  });

  it("names the key files and folds the rest, counting tests", () => {
    const src = top(tree, "billing").folders[0];
    expect(paths(src?.key ?? [])).toEqual(["billing/src/ledger.ts", "billing/src/reconcile.ts"]);
    expect(src?.rest).toHaveLength(6);
    expect(src?.restTests).toBe(3);
    expect(src?.foldRest).toBe(true);
    // Rest biggest first.
    expect(src?.rest[0]?.path).toBe("billing/src/ledger.test.ts");
  });

  it("lists a folder's files directly when it has no key files and at most two", () => {
    expect(top(tree, ".github/workflows").foldRest).toBe(false);
    expect(top(tree, "billing").foldRest).toBe(false); // README.md, package.json
    expect(top(tree, "(root config)").foldRest).toBe(true); // six normal files
    const one = changeTree(
      source([
        ["a/x.ts", "critical", 1],
        ["a/y.ts", "normal", 1],
      ]),
    );
    expect(one.folders[0]?.foldRest).toBe(true); // a key file and one more: "+ 1 more file"
  });

  it("counts files, files to read, lines, the worst level and new folders", () => {
    const billing = top(tree, "billing");
    expect(billing.summary).toMatchObject({
      files: 10,
      toRead: 2,
      worst: "important",
      additions: 1284,
      isNew: true,
      byLevel: { critical: 0, important: 2, normal: 8 },
    });
    expect(top(tree, "scripts/security").summary).toMatchObject({ toRead: 0, worst: "normal" });
    const modified = changeTree(
      source([
        ["a/x.ts", "normal", 2, false],
        ["a/y.ts", "normal", 2],
      ]),
    );
    expect(modified.folders[0]?.summary.isNew).toBe(false);
    expect(modified.folders[0]?.summary.deletions).toBe(1);
  });

  it("sorts folders by lines changed, biggest first, (root config) last", () => {
    expect(tree.folders.map((f) => f.summary.additions)).toEqual([1284, 122, 66, 63, 77]);
  });

  it("calls a folder new only when every changed file under it was added, ignored ones too", () => {
    const t = changeTree(
      source([
        ["src/a.ts", "critical", 4],
        ["src/lock.json", "noise", 9, false],
        ["lib/b.ts", "normal", 2],
        ["lib/old.ts", "low", 1, false],
        ["new/c.ts", "normal", 1],
        ["new/d.bin", "unanalysed", 0],
        ["x.ts", "normal", 1],
        ["y.md", "low", 1, false],
      ]),
    );
    expect(top(t, "src").summary.isNew).toBe(false);
    expect(top(t, "lib").summary.isNew).toBe(false);
    expect(top(t, "new").summary.isNew).toBe(true);
    expect(top(t, "(root config)").summary.isNew).toBe(false);
    const modifiedUnanalysed = changeTree(
      source([
        ["n/c.ts", "normal", 1],
        ["n/d.bin", "unanalysed", 0, false],
      ]),
    );
    expect(modifiedUnanalysed.folders[0]?.summary.isNew).toBe(false);
  });

  it("starts the riskiest top folder expanded, the biggest of equals", () => {
    expect(tree.expanded).toBe(top(tree, "billing").id);
    const riskier = changeTree(
      source([
        ["big/a.ts", "normal", 900],
        ["small/b.ts", "critical", 3],
      ]),
    );
    expect(names(riskier.folders)).toEqual(["big", "small"]);
    expect(riskier.expanded).toBe(top(riskier, "small").id);
  });

  it("gives the header counts: every file, the folders with changes, the files to read", () => {
    expect(tree.total).toBe(29);
    // Over every changed file, as the file count: billing, billing/src, .github/workflows,
    // scripts/security, docs/adr, docs (progress.md, ignored) and the root.
    expect(tree.folderCount).toBe(7);
    expect(tree.toRead).toBe(3);
  });

  it("keeps unanalysed files as their own visible group", () => {
    const t = changeTree(
      source([
        ["src/a.ts", "critical", 4],
        ["src/b.bin", "unanalysed", 0],
        ["c.ts", "noise", 1],
      ]),
    );
    expect(paths(t.unanalysed)).toEqual(["src/b.bin"]);
    expect(t.unanalysed[0]?.level).toBe("unanalysed");
    expect(t.total).toBe(3);
    expect(paths(top(t, "src").key)).toEqual(["src/a.ts"]);
  });

  it("gives every folder a distinct id", () => {
    const ids: string[] = [];
    const walk = (fs: readonly TreeFolder[]) => {
      for (const f of fs) {
        ids.push(f.id);
        walk(f.folders);
      }
    };
    walk(tree.folders);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds from a real analysis document", () => {
    const parsed = parseAnalysisDocument(pr847);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const t = changeTree(parsed.value);
    expect(names(t.folders)).toEqual(["src", "web/src/pages", "db/migrations"]);
    expect(names(top(t, "src").folders)).toEqual(["auth", "api/routes", "jobs"]);
    expect(t.toRead).toBe(4);
    expect(t.total).toBe(9);
    // src/api/index.ts and src/generated/api-types.ts (ignored) are modified: src is not new.
    expect(top(t, "src").summary.isNew).toBe(false);
    expect(top(t, "db/migrations").summary.isNew).toBe(true);
    // src/auth, src/api/routes, src/api, src/generated, src/jobs, web/src/pages,
    // db/migrations and the root (pnpm-lock.yaml).
    expect(t.folderCount).toBe(8);
    expect(paths(t.ignored.files)).toEqual([
      "src/generated/api-types.ts",
      "pnpm-lock.yaml",
      "src/api/index.ts",
    ]);
    expect(t.expanded).toBe(top(t, "src").id);
  });
});

describe("initialOpen", () => {
  const tree = changeTree(source(LEDGER));

  it("opens the default folder and its folders down to the files to read", () => {
    const open = initialOpen(tree, null);
    const billing = top(tree, "billing");
    expect([...open.folders]).toEqual([billing.id, billing.folders[0]?.id]);
    const t = changeTree(
      source([
        ["a/x/k.ts", "critical", 1],
        ["a/y/n.ts", "normal", 9],
        ["b/m.ts", "important", 1],
      ]),
    );
    const a = top(t, "a");
    expect([...initialOpen(t, null).folders]).toEqual([
      a.id,
      a.folders.find((f) => f.name === "x")?.id,
    ]);
    expect(open.more.size).toBe(0);
    expect(open.ignored).toBe(false);
  });

  it("reveals the selected file: its folders, its folded files, the ignored group", () => {
    const deep = initialOpen(tree, "billing/src/money.ts");
    const src = top(tree, "billing").folders[0];
    expect(deep.folders.has(src?.id ?? "")).toBe(true);
    expect(deep.more.has(src?.id ?? "")).toBe(true);
    const workflow = initialOpen(tree, ".github/workflows/ci.yml");
    expect(workflow.folders.has(top(tree, ".github/workflows").id)).toBe(true);
    expect(initialOpen(tree, "pnpm-lock.yaml").ignored).toBe(true);
  });
});

describe("isTestPath", () => {
  it("knows test files by name and folder", () => {
    for (const p of ["a/x.test.ts", "x.spec.tsx", "a/__tests__/x.ts", "tests/x.py", "a/test/x.go"])
      expect(isTestPath(p)).toBe(true);
    for (const p of ["a/testing.ts", "contest/x.ts", "latest.ts"])
      expect(isTestPath(p)).toBe(false);
  });
});
