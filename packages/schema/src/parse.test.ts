import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./document.js";
import { formatIssues, formatPath } from "./errors.js";
import { parseAnalysisDocument } from "./parse.js";
import { expectAccepted, expectRejected, pr847 } from "./test-helpers.js";

describe("parseAnalysisDocument: shape", () => {
  it("accepts the pr-847 fixture", () => {
    expectAccepted(pr847());
  });

  it.each([null, undefined, 42, "{}", [], true])("rejects a non-object root %j", (input) => {
    expectRejected(input, "INVALID_SHAPE", "");
  });

  it("rejects unknown fields at the root", () => {
    const doc = { ...pr847(), extra: 1 };
    expectRejected(doc, "INVALID_SHAPE", "");
  });

  it.each([
    ["briefing", (d: ReturnType<typeof pr847>) => Object.assign(d.briefing, { tone: "x" })],
    [
      "triage.files[0]",
      (d: ReturnType<typeof pr847>) => Object.assign(d.triage.files[0]!, { x: 1 }),
    ],
    [
      "findings[0]",
      (d: ReturnType<typeof pr847>) => Object.assign(d.findings[0]!, { html: "<b>" }),
    ],
    [
      "findings[0].range",
      (d: ReturnType<typeof pr847>) => Object.assign(d.findings[0]!.range, { side: "old" }),
    ],
    [
      "graph.nodes[0]",
      (d: ReturnType<typeof pr847>) => Object.assign(d.graph!.nodes[0]!, { x: 1 }),
    ],
    [
      "graph.edges[0]",
      (d: ReturnType<typeof pr847>) => Object.assign(d.graph!.edges![0]!, { x: 1 }),
    ],
    [
      "graph.views[0].children[0]",
      (d: ReturnType<typeof pr847>) => Object.assign(d.graph!.views![0]!.children![0]!, { x: 1 }),
    ],
    [
      "provenance.files[0]",
      (d: ReturnType<typeof pr847>) => Object.assign(d.provenance.files[0]!, { patch: "..." }),
    ],
    [
      "provenance.repo",
      (d: ReturnType<typeof pr847>) => Object.assign(d.provenance.repo, { url: "x" }),
    ],
  ])("rejects unknown fields at %s", (path, mutate) => {
    const doc = pr847();
    mutate(doc);
    expectRejected(doc, "INVALID_SHAPE", path);
  });

  it("reports the precise path of a wrong type", () => {
    const doc = pr847();
    (doc.findings[1] as { confidence: unknown }).confidence = "high";
    expectRejected(doc, "INVALID_SHAPE", "findings[1].confidence");
  });

  it("rejects an oversized string with the path of that string", () => {
    const doc = pr847();
    doc.findings[0]!.title = "x".repeat(10_000);
    expectRejected(doc, "INVALID_SHAPE", "findings[0].title");
  });

  it("rejects an oversized array with the path of that array", () => {
    const doc = pr847();
    doc.briefing.checkedOk = Array.from({ length: 1000 }, (_, i) => `item ${i}`);
    expectRejected(doc, "INVALID_SHAPE", "briefing.checkedOk");
  });

  it("rejects control characters in prose, titles and paths", () => {
    const body = pr847();
    body.findings[0]!.body = "ok\u0000bad";
    expectRejected(body, "INVALID_SHAPE", "findings[0].body");

    const title = pr847();
    title.findings[0]!.title = "line\nbreak";
    expectRejected(title, "INVALID_SHAPE", "findings[0].title");

    const path = pr847();
    path.triage.noise![0]!.path = "a\u001bb";
    expectRejected(path, "INVALID_SHAPE", "triage.noise[0].path");
  });

  it("fills defaults so the stored form is canonical", () => {
    const doc = pr847();
    const edge = doc.graph!.edges![0]!;
    delete (edge as { emphasis?: unknown }).emphasis;
    delete (edge as { animated?: unknown }).animated;
    delete (edge as { files?: unknown }).files;
    const value = expectAccepted(doc);
    expect(value.graph!.edges[0]).toMatchObject({ emphasis: "normal", animated: false, files: [] });
  });

  it("accepts a document without a graph", () => {
    const doc = pr847();
    delete doc.graph;
    expectAccepted(doc);
  });
});

describe("parseAnalysisDocument: version", () => {
  it("rejects an unsupported minor or major", () => {
    for (const version of ["1.1.0", "2.0.0", "0.9.0"]) {
      const doc = pr847();
      doc.schemaVersion = version;
      expectRejected(doc, "UNSUPPORTED_SCHEMA_VERSION", "schemaVersion");
    }
  });

  it("accepts any patch of the current minor", () => {
    const doc = pr847();
    doc.schemaVersion = SCHEMA_VERSION.replace(/\d+$/, "7");
    expectAccepted(doc);
  });

  it("rejects a malformed version as a shape error", () => {
    const doc = pr847();
    doc.schemaVersion = "latest";
    expectRejected(doc, "INVALID_SHAPE", "schemaVersion");
  });
});

describe("parseAnalysisDocument: never throws", () => {
  it("reports a document nested too deeply", () => {
    let nested: Record<string, unknown> = { id: "leaf", title: "t" };
    for (let i = 0; i < 100_000; i += 1) nested = { id: `v${i}`, title: "t", children: [nested] };
    const doc = pr847();
    doc.graph!.views = [nested as never];
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(["TOO_DEEP", "INVALID_SHAPE", "LIMIT_EXCEEDED"]).toContain(result.error.code);
  });

  it("reports an input whose property access throws instead of throwing", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new TypeError("boom");
        },
      },
    );
    const result = parseAnalysisDocument(hostile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.message).not.toContain("boom");
  });

  it("reports a throwing getter deep in the document instead of throwing", () => {
    const doc = pr847() as unknown as Record<string, unknown>;
    Object.defineProperty(doc, "findings", {
      enumerable: true,
      get() {
        throw new Error("secret-content");
      },
    });
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.message).not.toContain("secret-content");
  });

  it("ignores prototype pollution attempts (own properties only)", () => {
    const doc = JSON.parse(
      JSON.stringify(pr847()).replace('"findings":', '"__proto__":{"polluted":1},"findings":'),
    );
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("issue formatting", () => {
  it("formats paths like a JSON accessor", () => {
    expect(formatPath([])).toBe("");
    expect(formatPath(["findings", 2, "range", "end"])).toBe("findings[2].range.end");
    expect(formatPath([0, "a"])).toBe("[0].a");
  });

  it("lists every issue with its code and path", () => {
    const text = formatIssues([
      { code: "DUPLICATE_ID", path: "findings[1].id", message: "dup" },
      { code: "TOO_DEEP", path: "", message: "deep" },
    ]);
    expect(text).toBe("findings[1].id: dup [DUPLICATE_ID]\n<root>: deep [TOO_DEEP]");
  });

  it("uses the first issue's code as the error code", () => {
    const doc = pr847();
    doc.findings[0]!.id = "F2";
    doc.findings[2]!.path = "nope.ts";
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(result.error.issues[0]!.code);
    expect(result.error.issues.length).toBeGreaterThan(1);
  });
});
