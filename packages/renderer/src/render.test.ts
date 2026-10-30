import { describe, expect, it } from "vitest";
import { CHANGE_MAP_UNAVAILABLE, renderChangeMap, type ChangeMapSource } from "./index.js";
import { deepNesting, longLabels, pr847, singleNode, wideFanOut } from "./test-support.js";

const SHAPES: Record<string, () => ChangeMapSource> = {
  "pr-847": pr847,
  "single-node": singleNode,
  "wide-fan-out": wideFanOut,
  "deep-nesting": deepNesting,
  "long-labels": longLabels,
};

/**
 * Every `<g class="cm-node …" data-node="id">…</g>` group, with the badge group drawn right
 * after it (a sibling since P5-3), by node id.
 */
const nodeGroups = (svg: string): Map<string, string> =>
  new Map(
    [
      ...svg.matchAll(
        /<g class="cm-node[^"]*" data-node="([^"]+)"[^>]*>([\s\S]*?<\/g>(?:\n<g class="cm-badge[^"]*"[\s\S]*?<\/g>)?)/g,
      ),
    ].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );

/** The opening tag of an element whose attribute `name` is `value`. */
const openTag = (svg: string, name: string, value: string): string =>
  new RegExp(`<g [^>]*${name}="${value}"[^>]*>`).exec(svg)?.[0] ?? "";

describe("determinism", () => {
  for (const [name, build] of Object.entries(SHAPES))
    it(`${name}: 100 renders are byte-identical`, () => {
      const first = renderChangeMap(build()).svg;
      for (let run = 0; run < 100; run += 1) expect(renderChangeMap(build()).svg).toBe(first);
    });

  it("ignores the input's key order", () => {
    const reversedKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversedKeys);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, nested]) => [key, reversedKeys(nested)]),
      );
    };
    const doc = pr847();
    expect(renderChangeMap(reversedKeys(doc) as ChangeMapSource).svg).toBe(
      renderChangeMap(doc).svg,
    );
  });

  it("ignores fields the map never draws", () => {
    const doc = pr847();
    const graph = doc.graph!;
    const annotated: ChangeMapSource = {
      ...doc,
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, summary: "Drill-down prose only." })),
        flows: [],
        views: [],
      },
    };
    expect(renderChangeMap(annotated).svg).toBe(renderChangeMap(doc).svg);
  });

  it("writes every number with at most two decimals", () => {
    for (const build of Object.values(SHAPES)) {
      const { svg } = renderChangeMap(build());
      expect(svg).not.toMatch(/\d\.\d{3,}/);
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});

describe("the map", () => {
  it("reports its size and matches the viewBox", () => {
    const map = renderChangeMap(pr847());
    expect(map.status).toBe("rendered");
    expect(map.svg).toContain(`viewBox="0 0 ${map.width} ${map.height}"`);
    expect(Number.isInteger(map.width) && Number.isInteger(map.height)).toBe(true);
  });

  it("draws every lane that holds a card, in declared order", () => {
    const { svg } = renderChangeMap(pr847());
    const lanes = [...svg.matchAll(/<text class="cm-lane-label"[^>]*>([^<]*)<\/text>/g)].map(
      (match) => match[1],
    );
    expect(lanes).toEqual(["WEB", "API", "DATA", "WORKERS"]);
  });

  it("classes every card by its delta", () => {
    const { svg } = renderChangeMap(longLabels());
    expect(svg).toContain('class="cm-node cm-added"');
    expect(svg).toContain('class="cm-node cm-removed"');
    expect(svg).toContain('class="cm-node cm-modified"');
    expect(svg).toContain('class="cm-node cm-unchanged"');
  });

  it("marks hero edges, animated edges and muted ones", () => {
    const { svg } = renderChangeMap(pr847());
    expect(svg.match(/class="cm-edge cm-added cm-hero cm-animated"/g)).toHaveLength(2);
    const muted = renderChangeMap(longLabels()).svg;
    expect(muted).toContain("cm-muted");
  });

  it("uses no colour, style or font attribute: everything comes from classes and tokens", () => {
    for (const build of Object.values(SHAPES)) {
      const { svg } = renderChangeMap(build());
      expect(svg).not.toMatch(/\s(fill|stroke|style|color|font-[a-z]+|opacity)=/);
      expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("namespaces marker ids so two maps can share a page", () => {
    const { svg } = renderChangeMap(pr847(), { idPrefix: "brief-1" });
    expect(svg).toContain('id="brief-1-arrow-added"');
    expect(svg).toContain('marker-end="url(#brief-1-arrow-added)"');
    expect(svg).not.toContain('id="cm-arrow');
  });

  it("refuses an id prefix that is not a plain token", () => {
    expect(() => renderChangeMap(pr847(), { idPrefix: 'x" onload="y' })).toThrow(/idPrefix/);
    expect(() => renderChangeMap(pr847(), { idPrefix: "" })).toThrow(/idPrefix/);
  });

  it("keeps edge labels clear of every card (POC defect 3)", () => {
    for (const build of Object.values(SHAPES)) {
      const { svg } = renderChangeMap(build());
      const boxes = (pattern: RegExp) =>
        [...svg.matchAll(pattern)].map((match) => ({
          x: Number(match[1]),
          y: Number(match[2]),
          width: Number(match[3]),
          height: Number(match[4]),
        }));
      const cards = boxes(
        /<rect class="cm-card" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
      );
      const pills = boxes(
        /<rect class="cm-pill" x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g,
      );
      for (const pill of pills)
        for (const card of cards) {
          const overlaps =
            pill.x < card.x + card.width &&
            card.x < pill.x + pill.width &&
            pill.y < card.y + card.height &&
            card.y < pill.y + pill.height;
          expect(overlaps, `${JSON.stringify(pill)} over ${JSON.stringify(card)}`).toBe(false);
        }
    }
  });

  it("cuts long text with an ellipsis and keeps the full text in the tooltip", () => {
    const { svg } = renderChangeMap(longLabels());
    expect(svg).toMatch(/<text class="cm-node-title"[^>]*>AAAAAAAAAA very[^<]*…<\/text>/);
    expect(svg).toContain(`<title>${"A".repeat(10)} very long label`);
    expect(svg).toMatch(/<text class="cm-lane-label"[^>]*>[^<]*…<\/text>/);
  });

  it("draws a self-loop and a cycle without hanging", () => {
    const { svg } = renderChangeMap(longLabels());
    expect(svg).toContain('data-edge="loop"');
    expect(renderChangeMap(deepNesting()).svg).toContain('data-edge="retry"');
  });
});

describe("finding badges", () => {
  it("counts findings per card and colours the badge by the worst severity", () => {
    const groups = nodeGroups(renderChangeMap(pr847()).svg);
    // auth: F1 critical, F3 high, F8 low (src/auth/invitations.ts, lines 19-33).
    expect(groups.get("auth")).toMatch(/class="cm-badge cm-critical" data-findings="F1 F3 F8"/);
    expect(groups.get("auth")).toMatch(/<text class="cm-badge-count"[^>]*>3<\/text>/);
    // route: F2 high, F7 medium.
    expect(groups.get("route")).toMatch(/class="cm-badge cm-high" data-findings="F2 F7"/);
    // invitations table: F4 high, F5 medium.
    expect(groups.get("inv")).toMatch(/class="cm-badge cm-high" data-findings="F4 F5"/);
    expect(groups.get("job")).toMatch(/class="cm-badge cm-medium" data-findings="F6"/);
    expect(groups.get("page")).toMatch(/class="cm-badge cm-low" data-findings="F9"/);
    // memberships and the mailer back no file with a finding.
    expect(groups.get("mem")).not.toContain("cm-badge");
    expect(groups.get("mail")).not.toContain("cm-badge");
  });

  it("matches a finding to a file ref with a range only when the lines overlap", () => {
    const doc = pr847();
    const outside = doc.findings.map((f) =>
      f.id === "F1" ? { ...f, range: { start: 2, end: 4 } } : f,
    );
    const groups = nodeGroups(renderChangeMap({ ...doc, findings: outside }).svg);
    expect(groups.get("auth")).toMatch(/class="cm-badge cm-high" data-findings="F3 F8"/);
  });

  it("draws only the findings it is given, so the caller can leave out dismissed ones", () => {
    const doc = pr847();
    const open = doc.findings.filter((f) => f.id !== "F1");
    const groups = nodeGroups(renderChangeMap({ ...doc, findings: open }).svg);
    expect(groups.get("auth")).toMatch(/class="cm-badge cm-high" data-findings="F3 F8"/);
    expect(renderChangeMap({ ...doc, findings: [] }).svg).not.toContain("cm-badge");
  });

  it("caps the visible count and keeps the exact number in the tooltip", () => {
    const { svg } = renderChangeMap(longLabels());
    const long = nodeGroups(svg).get("long");
    expect(long).toMatch(/<text class="cm-badge-count"[^>]*>9\+<\/text>/);
    expect(long).toContain("12 findings, worst high");
  });
});

describe("click-through (P5-3)", () => {
  const files = (doc = pr847()) => doc.provenance.files.map((file) => file.path);

  it("is a picture without the option: no button, no tabindex, role img", () => {
    const { svg } = renderChangeMap(pr847());
    expect(svg).not.toContain("tabindex");
    expect(svg).not.toContain('role="button"');
    expect(svg).toMatch(/^<svg [^>]*role="img"/);
  });

  it("makes each card backed by a PR file a named button, and the root a group", () => {
    const { svg } = renderChangeMap(pr847(), { interactive: { files: files() } });
    expect(svg).toMatch(/^<svg [^>]*role="group" aria-label="Change map"/);
    expect(openTag(svg, "data-node", "page")).toBe(
      '<g class="cm-node cm-added" data-node="page" tabindex="0" role="button" ' +
        'aria-label="InvitePage web/src/pages, opens web/src/pages/InvitePage.tsx">',
    );
    expect(openTag(svg, "data-node", "auth")).toContain(
      'aria-label="acceptInvitation() src/auth, opens src/auth/invitations.ts"',
    );
    // memberships is backed by a file outside the PR; the mailer by none.
    expect(openTag(svg, "data-node", "mem")).toBe(
      '<g class="cm-node cm-unchanged" data-node="mem">',
    );
    expect(openTag(svg, "data-node", "mail")).toBe(
      '<g class="cm-node cm-unchanged" data-node="mail">',
    );
  });

  it("makes each badge a named button for its worst finding, after its card", () => {
    const { svg } = renderChangeMap(pr847(), { interactive: { files: files() } });
    expect(openTag(svg, "data-findings", "F1 F3 F8")).toBe(
      '<g class="cm-badge cm-critical" data-findings="F1 F3 F8" tabindex="0" role="button" ' +
        'aria-label="3 findings on acceptInvitation(), worst critical: go to src/auth/invitations.ts line 28">',
    );
    expect(openTag(svg, "data-findings", "F9")).toContain(
      'aria-label="1 finding on InvitePage, worst low: go to web/src/pages/InvitePage.tsx line 13"',
    );
    // Tab order is document order: each card, then its badge, never one inside the other.
    const order = [...svg.matchAll(/tabindex="0"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(order.slice(0, 2)).toEqual([
      "InvitePage web/src/pages, opens web/src/pages/InvitePage.tsx",
      "1 finding on InvitePage, worst low: go to web/src/pages/InvitePage.tsx line 13",
    ]);
    expect(nodeGroups(svg).get("auth")).toMatch(/<\/g>\n<g class="cm-badge cm-critical"/);
  });

  it("leaves a card and a badge inert when their file is not in the PR", () => {
    const doc = pr847();
    const { svg } = renderChangeMap(doc, {
      interactive: { files: files(doc).filter((path) => path !== "src/auth/invitations.ts") },
    });
    expect(openTag(svg, "data-node", "auth")).toBe('<g class="cm-node cm-added" data-node="auth">');
    expect(openTag(svg, "data-findings", "F1 F3 F8")).toBe(
      '<g class="cm-badge cm-critical" data-findings="F1 F3 F8">',
    );
  });

  it("names a card by the text drawn on it, normalised, then the file it opens", () => {
    const doc = pr847();
    const label = `\u202Eevil\u200B${"x".repeat(600)}`;
    const { svg } = renderChangeMap(
      { ...doc, graph: { ...doc.graph!, nodes: doc.graph!.nodes.map((n) => ({ ...n, label })) } },
      { interactive: { files: files(doc) } },
    );
    const card = /<g [^>]*data-node="page"[^>]*>[\s\S]*?<\/g>/.exec(svg)?.[0] ?? "";
    const drawn = /<text class="cm-node-title"[^>]*>([^<]*)<\/text>/.exec(card)?.[1] ?? "";
    expect(drawn.startsWith("evilxxx")).toBe(true);
    expect(drawn.endsWith("…")).toBe(true);
    expect(card).toContain(
      `aria-label="${drawn} web/src/pages, opens web/src/pages/InvitePage.tsx"`,
    );
  });

  it("is deterministic and draws the same picture as the inert map", () => {
    const options = { interactive: { files: files() } };
    const first = renderChangeMap(pr847(), options).svg;
    for (let run = 0; run < 20; run += 1) expect(renderChangeMap(pr847(), options).svg).toBe(first);
    // The badges' hit areas are invisible (fill none, P6-8), so they are not part of the picture.
    const strip = (svg: string) =>
      svg
        .replace(/ (?:tabindex|role|aria-label)="[^"]*"/g, "")
        .replace(/<rect class="cm-badge-hit"[^>]*\/>\n?/g, "");
    expect(strip(first)).toBe(strip(renderChangeMap(pr847()).svg));
  });

  it("gives each clickable badge, and only those, a 32-unit target centred on it (P6-8)", () => {
    const doc = pr847();
    const { svg } = renderChangeMap(doc, {
      interactive: { files: files(doc).filter((path) => path !== "src/auth/invitations.ts") },
    });
    const badges = [...svg.matchAll(/<g class="cm-badge [^"]*"[^>]*>([\s\S]*?)<\/g>/g)];
    expect(badges.length).toBe(5);
    for (const [group, body] of badges) {
      const hit =
        /<rect class="cm-badge-hit" x="([\d.-]+)" y="([\d.-]+)" width="32" height="32"\/>/.exec(
          body ?? "",
        );
      // acceptInvitation()'s file is left out, so its badge is inert and has no target.
      if (group.includes('data-findings="F1 F3 F8"')) {
        expect(hit).toBeNull();
        continue;
      }
      expect(hit, group).not.toBeNull();
      const bg =
        /<rect class="cm-badge-bg" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/.exec(
          body ?? "",
        );
      const [hx, hy, bx, by, bw, bh] = [hit?.[1], hit?.[2], bg?.[1], bg?.[2], bg?.[3], bg?.[4]].map(
        Number,
      ) as [number, number, number, number, number, number];
      expect(hx + 16).toBeCloseTo(bx + bw / 2, 1);
      expect(hy + 16).toBeCloseTo(by + bh / 2, 1);
      // Drawn first, so the visible badge paints over it.
      expect(body?.indexOf("cm-badge-hit")).toBeLessThan(body?.indexOf("cm-badge-bg") ?? 0);
    }
  });
});

describe("unavailable map", () => {
  it("says why when the pipeline recorded a reason", () => {
    const map = renderChangeMap({
      findings: [],
      provenance: { graphUnavailable: { reason: "too-large" } },
    });
    expect(map.status).toBe("unavailable");
    if (map.status !== "unavailable") return;
    expect(map.reason).toBe("too-large");
    expect(map.svg).toContain(CHANGE_MAP_UNAVAILABLE);
    expect(map.svg).toContain("The pull request is too large to map.");
  });

  it("shows only the heading when the document has no graph and no reason", () => {
    const map = renderChangeMap({ findings: [], provenance: {} });
    expect(map.status).toBe("unavailable");
    if (map.status !== "unavailable") return;
    expect(map.reason).toBeUndefined();
    expect(map.svg).toContain(CHANGE_MAP_UNAVAILABLE);
    expect(map.svg).not.toContain("cm-unavailable-reason");
  });

  it("treats a graph with no cards as unavailable rather than drawing an empty frame", () => {
    const map = renderChangeMap({
      graph: { lanes: [{ id: "a", label: "A" }], nodes: [], edges: [], flows: [], views: [] },
      findings: [],
      provenance: {},
    });
    expect(map.status).toBe("unavailable");
  });

  it("never draws the pipeline's free-text detail, only Rocky's own sentence for the reason", () => {
    const map = renderChangeMap({
      findings: [],
      provenance: { graphUnavailable: { reason: "timeout", detail: "Graph role timed out." } },
    });
    expect(map.svg).not.toContain("Graph role timed out.");
    expect(map.svg).toContain("The change map took too long to build.");
  });
});

describe("purity", () => {
  it("reads no clock, randomness, locale or DOM", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const root = new URL("./", import.meta.url);
    const sources = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "test-support.ts",
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const code = readFileSync(new URL(file, root), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(
        /\bDate\b|Math\.random|performance\.|toLocale|localeCompare|\bIntl\b|\bdocument\.|\bwindow\b|\bprocess\b|crypto|from "node:/,
      );
    }
  });

  it("renders the largest graph the schema allows, deterministically and quickly", () => {
    const lanes = Array.from({ length: 16 }, (_, index) => ({
      id: `l${index}`,
      label: `L${index}`,
    }));
    const nodes = Array.from({ length: 256 }, (_, index) => ({
      id: `n${index}`,
      label: `Node ${index}`,
      kind: "module" as const,
      delta: (["added", "modified", "removed", "unchanged"] as const)[index % 4] ?? "added",
      lane: `l${index % 16}`,
      subtitle: `src/n${index}.ts`,
      files: [{ path: `src/n${index}.ts` }],
      badges: [],
    }));
    const edges = Array.from({ length: 512 }, (_, index) => ({
      id: `e${index}`,
      from: `n${(index * 7) % 256}`,
      to: `n${(index * 13 + 5) % 256}`,
      kind: "call" as const,
      delta: "added" as const,
      label: `call ${index}`,
      emphasis: "normal" as const,
      animated: false,
      files: [],
    }));
    const source: ChangeMapSource = {
      graph: { lanes, nodes, edges, flows: [], views: [] },
      findings: [],
      provenance: {},
    };
    const started = Date.now();
    const first = renderChangeMap(source).svg;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(renderChangeMap(source).svg).toBe(first);
    expect(first.match(/class="cm-card"/g)).toHaveLength(256);
    expect(first.match(/data-edge="e\d+" d=/g)).toHaveLength(512);
    // Two renders under coverage on a CI runner take ~7 s; the budget above is per render.
  }, 30_000);
});
