/**
 * The escaping seam P5-2 builds on: every text and attribute value is escaped where it is
 * written (svg/markup.ts), and the markup layer refuses elements and attributes that could run
 * code or load anything. P5-2 (sanitisation, 🔴) extends this suite with its hostile-label corpus.
 */
import { describe, expect, it } from "vitest";
import { renderChangeMap, type ChangeMapSource } from "./index.js";
import { escapeXml, tag, wrap } from "./svg/markup.js";
import { pr847 } from "./test-support.js";

const HOSTILE = [
  "<script>alert(1)</script>",
  '"><foreignObject><div>x</div></foreignObject>',
  "' onmouseover='alert(1)",
  '" onload="alert(1)',
  '</text><a href="javascript:alert(1)">x</a>',
  "]]><!--",
  "&amp; &lt;already&gt; escaped",
];

/** pr-847 with every label, subtitle and badge replaced by `text`. */
const withLabels = (text: string): ChangeMapSource => {
  const doc = pr847();
  const graph = doc.graph!;
  return {
    ...doc,
    graph: {
      ...graph,
      lanes: graph.lanes.map((lane) => ({ ...lane, label: text, subtitle: text })),
      nodes: graph.nodes.map((node) => ({ ...node, label: text, subtitle: text, badges: [text] })),
      edges: graph.edges.map((edge) => ({ ...edge, label: text })),
    },
  };
};

describe("escaping", () => {
  it("escapes the five XML specials and drops characters XML cannot spell", () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeXml("a\u0000b\u0008c￾d")).toBe("abcd");
    expect(escapeXml("emoji 😀 stays")).toBe("emoji 😀 stays");
  });

  for (const text of HOSTILE)
    it(`a hostile label stays text: ${JSON.stringify(text)}`, () => {
      const { svg } = renderChangeMap(withLabels(text));
      // Escaped text cannot hold a raw `<` or `>`, so every `<…>` is markup the renderer wrote.
      const tags = [...svg.matchAll(/<\/?([a-zA-Z][\w:-]*)([^<>]*)>/g)];
      expect(svg.split("<").length - 1).toBe(tags.length);
      expect(svg.split(">").length - 1).toBe(tags.length);
      for (const [, name = "", attributes = ""] of tags) {
        expect(ALLOWED.has(name), `element <${name}>`).toBe(true);
        for (const [, attribute = ""] of attributes.matchAll(/\s([^\s=/]+)="[^"]*"/g))
          expect(ALLOWED_ATTRIBUTE.test(attribute), `attribute ${attribute}`).toBe(true);
        // Nothing outside name="value" pairs: no stray, unquoted or broken-out attribute.
        expect(attributes.replace(/\s[^\s=/]+="[^"]*"/g, "").replace(/\/$/, "")).toBe("");
      }
      expect(svg).not.toMatch(/<!--|<!\[CDATA\[|<\?/);
    });
});

const ALLOWED = new Set(["svg", "defs", "marker", "path", "g", "rect", "text", "title"]);
/** Geometry, classes, marker ids, ARIA and data-* hooks: never on*, href, src or style. */
const ALLOWED_ATTRIBUTE =
  /^(?:xmlns|viewBox|width|height|x|y|rx|d|class|id|role|aria-label|aria-hidden|text-anchor|marker-end|markerWidth|markerHeight|refX|refY|orient|data-[a-z][a-z0-9-]*)$/;

describe("the markup layer refuses what could run or load", () => {
  it.each(["script", "foreignObject", "a", "image", "use", "style", "iframe"])(
    "element <%s>",
    (name) => {
      expect(() => tag(name, {})).toThrow(/element/);
      expect(() => wrap(name, {}, "")).toThrow(/element/);
    },
  );

  it.each(["onload", "onclick", "href", "xlink:href", "style", "src", "Onload", "x y"])(
    "attribute %s",
    (name) => {
      expect(() => tag("rect", { [name]: "1" })).toThrow(/attribute/);
    },
  );

  it("escapes attribute values", () => {
    expect(tag("rect", { class: '"><script>' })).toBe('<rect class="&quot;&gt;&lt;script&gt;"/>');
  });
});
