/**
 * P5-2 (🔴): a hostile-label suite produces inert SVG. Every corpus entry is put in every text
 * field the map draws (lane label and subtitle, card label, subtitle and badge, edge label),
 * rendered, parsed by a strict XML parser and walked: only allowlisted elements and attributes,
 * no URL except the map's own `url(#<prefix>-…)` markers, and text equal to the input after the
 * documented normalisation (cut with an ellipsis where the layout or the tooltip cap says so).
 */
import { describe, expect, it } from "vitest";
import { renderChangeMap, type ChangeMapSource } from "./index.js";
import { HOSTILE_CORPUS, HOSTILE_IDS, HOSTILE_PREFIXES } from "./hostile-corpus.js";
import { inspectSvg, parseXml, type InertReport } from "./inspect.js";
import { normalised } from "./reference-normalise.js";
import { MAX_TEXT_LENGTH, MAX_TITLE_LENGTH } from "./svg/markup.js";
import { pr847, withLabels } from "./test-support.js";

const ELLIPSIS = "…";

/** `drawn` is `full`, or a prefix of it followed by an ellipsis. */
const isCutOf = (drawn: string, full: string): boolean =>
  drawn === full || (drawn.endsWith(ELLIPSIS) && full.startsWith(drawn.slice(0, -1)));

const codePoints = (text: string): number => [...text].length;

/** Checks every text the walk found against what the label should have become. */
const checkTexts = (report: InertReport, label: string): void => {
  const clean = normalised(label);
  const lane = normalised(`${clean} · ${clean}`.toUpperCase());
  // A tooltip joins several labels and is normalised again as one string (the joiner budget is
  // per string), so the expected text is the normalised join.
  const edge = normalised(`${clean} → ${clean} · ${clean}`);
  const card = normalised(`${clean} · ${clean} · ${clean}`);
  for (const { element, className, parentClass, text } of report.texts) {
    const where = `${element}.${className ?? parentClass}: ${JSON.stringify(text)}`;
    expect(codePoints(text), where).toBeLessThanOrEqual(
      (element === "title" ? MAX_TITLE_LENGTH : MAX_TEXT_LENGTH) + 1,
    );
    if (element === "text") {
      switch (className) {
        case "cm-node-title":
        case "cm-node-sub":
        case "cm-pill-text":
          expect(isCutOf(text, clean), where).toBe(true);
          break;
        case "cm-lane-label":
          expect(isCutOf(text, lane), where).toBe(true);
          break;
        case "cm-badge-count":
          expect(text, where).toMatch(/^\d\+?$/);
          break;
        default:
          throw new Error(`unexpected text ${where}`);
      }
    } else if (parentClass === "cm-lane") {
      expect(isCutOf(text, lane), where).toBe(true);
    } else if (parentClass.startsWith("cm-edge")) {
      expect(isCutOf(text, edge), where).toBe(true);
    } else if (parentClass.startsWith("cm-node")) {
      // The label parts must match exactly; what follows them is the renderer's own count
      // ("2 findings, worst high"), possibly cut, so it may hold only that alphabet.
      const rest = text.startsWith(`${card} · `) ? text.slice(card.length + 3) : undefined;
      expect(isCutOf(text, card) || /^[\d a-z,]*…?$/.test(rest ?? "\0"), where).toBe(true);
    } else {
      throw new Error(`unexpected title ${where}`);
    }
  }
};

describe("hostile labels render inert", () => {
  it("covers every technique the task names", () => {
    const techniques = new Set(HOSTILE_CORPUS.map(({ technique }) => technique));
    for (const technique of [
      "markup",
      "entities",
      "attribute break-out",
      "CDATA, comments and processing instructions",
      "URLs",
      "handlers and links",
      "styles",
      "CSS injection through class or data attributes",
      "bidi controls",
      "zero-width and invisible",
      "surrogates and non-characters",
      "case mapping",
      "length",
      "prompt injection (P4-4 corpus)",
    ])
      expect(techniques).toContain(technique);
    expect(HOSTILE_CORPUS.length).toBeGreaterThanOrEqual(150);
  });

  for (const { technique, label } of HOSTILE_CORPUS)
    it(`${technique}: ${JSON.stringify(label.length > 60 ? `${label.slice(0, 60)}…` : label)}`, () => {
      const map = renderChangeMap(withLabels(label));
      expect(map.status).toBe("rendered");
      const report = inspectSvg(map.svg);
      checkTexts(report, label);
      // Arrowheads only: five markers, every one referenced by its own prefix.
      expect(report.ids).toEqual([
        "cm-arrow-added",
        "cm-arrow-modified",
        "cm-arrow-removed",
        "cm-arrow-unchanged",
        "cm-arrow-hero",
      ]);
    });

  it("draws what an escaped label says, not what it spells", () => {
    const report = inspectSvg(renderChangeMap(withLabels("&lt;b&gt; <i>")).svg);
    const titles = report.texts.filter(({ className }) => className === "cm-node-title");
    expect(titles[0]?.text).toBe("&lt;b&gt; <i>");
  });

  it("keeps a lane header's case mapping, even when it changes the length", () => {
    const report = inspectSvg(renderChangeMap(withLabels("straße")).svg);
    const lanes = report.texts.filter(({ className }) => className === "cm-lane-label");
    expect(lanes[0]?.text).toBe("STRASSE · STRASSE");
  });

  it("keeps the heart-on-fire emoji whole", () => {
    const heart = "\u2764\uFE0F\u200D\u{1F525}";
    const report = inspectSvg(renderChangeMap(withLabels(`hot ${heart}`)).svg);
    const title = report.texts.find(({ className }) => className === "cm-node-title");
    expect(title?.text).toBe(`hot ${heart}`);
  });

  it("keeps the joiners real text needs and drops the ones that hide", () => {
    const family = "👨\u200D👩\u200D👧";
    const report = inspectSvg(renderChangeMap(withLabels(`${family}\u200D\u200D x\u200D`)).svg);
    const title = report.texts.find(({ className }) => className === "cm-node-title");
    expect(title?.text).toBe(`${family} x`);
  });

  it("strips every bidi control and zero-width character from the output", () => {
    const controls = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
    for (const { label } of HOSTILE_CORPUS.filter(({ technique }) =>
      ["bidi controls", "zero-width and invisible"].includes(technique),
    ))
      expect(renderChangeMap(withLabels(label)).svg).not.toMatch(controls);
  });

  it("caps the output however long the labels are", () => {
    const { svg } = renderChangeMap(withLabels("<&>".repeat(20_000)));
    // Every label is cut to its box and every tooltip to the cap: pr-847's map stays small.
    expect(svg.length).toBeLessThan(200_000);
  });
});

describe("ids, prefixes and references", () => {
  it("refuses an idPrefix that could break out of url(#…) or an id", () => {
    for (const idPrefix of HOSTILE_PREFIXES)
      expect(() => renderChangeMap(pr847(), { idPrefix }), idPrefix).toThrow(/idPrefix/);
  });

  it("namespaces every id and every reference by the prefix", () => {
    const map = renderChangeMap(pr847(), { idPrefix: "brief-2" });
    const report = inspectSvg(map.svg, "brief-2");
    expect(report.ids.every((id) => id.startsWith("brief-2-arrow-"))).toBe(true);
  });

  const withIds = (id: string, where: "node" | "edge" | "finding"): ChangeMapSource => {
    const doc = pr847();
    const graph = doc.graph!;
    const node = graph.nodes[0]!;
    return {
      ...doc,
      graph: {
        ...graph,
        nodes:
          where === "node" ? graph.nodes.map((n) => (n === node ? { ...n, id } : n)) : graph.nodes,
        edges: graph.edges.map((edge, index) =>
          where === "edge" && index === 0
            ? { ...edge, id }
            : where === "node"
              ? {
                  ...edge,
                  from: edge.from === node.id ? id : edge.from,
                  to: edge.to === node.id ? id : edge.to,
                }
              : edge,
        ),
      },
      findings:
        where === "finding"
          ? doc.findings.map((finding, index) => (index === 0 ? { ...finding, id } : finding))
          : doc.findings,
    };
  };

  for (const where of ["node", "edge", "finding"] as const)
    it(`fails closed on a ${where} id the schema would refuse`, () => {
      for (const id of HOSTILE_IDS)
        expect(() => renderChangeMap(withIds(id, where)), JSON.stringify(id)).toThrow(
          /data-|not allowed/,
        );
    });

  it("fails closed on an enum value the schema would refuse (class injection)", () => {
    const doc = pr847();
    const graph = doc.graph!;
    const forged = (patch: object, target: "node" | "edge"): ChangeMapSource => ({
      ...doc,
      graph: {
        ...graph,
        nodes:
          target === "node"
            ? graph.nodes.map((n, i) => (i === 0 ? ({ ...n, ...patch } as typeof n) : n))
            : graph.nodes,
        edges:
          target === "edge"
            ? graph.edges.map((e, i) => (i === 0 ? ({ ...e, ...patch } as typeof e) : e))
            : graph.edges,
      },
    });
    expect(() => renderChangeMap(forged({ delta: "added cm-hero" }, "node"))).toThrow(/class/);
    expect(() => renderChangeMap(forged({ delta: 'x" onload="y' }, "node"))).toThrow(/class/);
    expect(() => renderChangeMap(forged({ delta: "evil" }, "edge"))).toThrow(/class/);
    expect(() => renderChangeMap(forged({ emphasis: "hero cm-critical" }, "edge"))).toThrow(
      /class/,
    );
    const severity = {
      ...doc,
      findings: doc.findings.map((f, i) => (i === 0 ? { ...f, severity: "x cm-low" } : f)),
    } as unknown as ChangeMapSource;
    expect(() => renderChangeMap(severity)).toThrow(/class|severity/);
  });
});

describe("the unavailable panel", () => {
  it("draws fixed text only, whatever the pipeline's detail says", () => {
    const map = renderChangeMap({
      findings: [],
      provenance: {
        graphUnavailable: { reason: "timeout", detail: "<script>alert(1)</script>" },
      },
    } as ChangeMapSource);
    const report = inspectSvg(map.svg);
    expect(report.texts.map(({ text }) => text)).toEqual([
      "Change map unavailable",
      "The change map took too long to build.",
    ]);
  });
});

describe("the inspector itself", () => {
  // The walk is the proof, so it must catch each thing it claims to.
  const svg = (inner: string, attributes = "") =>
    `<svg xmlns="http://www.w3.org/2000/svg"${attributes}>${inner}</svg>`;
  it.each([
    ["a script", svg("<script>alert(1)</script>")],
    ["a foreignObject", svg("<foreignObject/>")],
    ["a handler", svg('<rect onload="x"/>')],
    ["an href", svg('<g href="#x"/>')],
    ["an xlink:href", svg('<g xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#x"/>')],
    ["a style attribute", svg('<rect style="display:none"/>')],
    ["an external marker", svg('<path marker-end="url(https://e.example/x#a)"/>')],
    ["a dangling marker", svg('<path marker-end="url(#cm-nowhere)"/>')],
    ["a foreign id", svg('<marker id="evil"/>')],
    ["a duplicate id", svg('<marker id="cm-a"/><marker id="cm-a"/>')],
    ["a stray class", svg('<g class="cm hero"/>')],
    ["a bad number", svg('<rect x="1;2"/>')],
    ["text in a group", svg("<g>hello</g>")],
    ["a bidi control", svg("<text>a\u202Eb</text>")],
    ["a zero-width space", svg('<g aria-label="a\u200Bb"/>')],
    ["a joiner run", svg("<text>a\u200D\u200Db</text>")],
    ["a joiner before a selector", svg("<text>a\u200D\uFE0Fb</text>")],
    ["alternating joiners", svg(`<text>a${"\u200D\uFE0F".repeat(4)}b</text>`)],
    ["a selector after a space", svg("<text>a \uFE0F</text>")],
    ["a selector after a letter", svg("<text>a\uFE0F</text>")],
    ["two selectors", svg("<text>\u2764\uFE0F\uFE0F</text>")],
    ["a trailing joiner", svg("<title>a\u200D</title>")],
    ["a joiner before a space", svg("<title>a\u200D b</title>")],
    [
      "too many joiners for the text",
      svg("<text>\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}</text>"),
    ],
    ["33 selectors", svg(`<text>${"\u2764\uFE0F".repeat(33)}</text>`)],
    ["a stray class on a lane", svg('<g class="cm-lane cm-hero"/>')],
    ["a severity on a lane", svg('<g class="cm-lane cm-critical"/>')],
    ["hero on a card", svg('<rect class="cm-card cm-hero"/>')],
    ["a comment", svg("<!-- x -->")],
    ["CDATA", svg("<text><![CDATA[x]]></text>")],
    ["a processing instruction", svg("<?x y?>")],
    ["a doctype", `<!DOCTYPE svg>${svg("")}`],
    ["an entity", svg("<text>&xxe;</text>")],
    ["an XHTML element", svg('<div xmlns="http://www.w3.org/1999/xhtml"/>')],
    ["a second namespace", svg("", ' xmlns:x="urn:x"')],
    ["malformed markup", svg("<text>a<b</text>")],
  ])("refuses %s", (_, markup) => {
    expect(() => inspectSvg(markup)).toThrow();
  });

  it("accepts what the renderer writes", () => {
    expect(() => parseXml(renderChangeMap(pr847()).svg)).not.toThrow();
  });

  it("accepts the joiners real text needs", () => {
    for (const text of [
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
      "\u2764\uFE0F\u200D\u{1F525}",
      "\u{1F3F3}\uFE0F\u200D\u{1F308} flag",
      "\u2764\uFE0F",
    ])
      expect(() => inspectSvg(svg(`<text>${text}</text>`)), text).not.toThrow();
  });
});
