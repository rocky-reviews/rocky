/**
 * H4-6: the three styles as first rendered, with and without reduced motion, the fallback
 * notice, and the stylesheets' promise that nothing moves under `prefers-reduced-motion`.
 * Stepping through B and C is in e2e/map-styles.e2e.spec.ts (it needs a browser).
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangeMapSlot } from "../briefing/ChangeMap.js";
import { FlowPlayback } from "./FlowPlayback.js";
import { LiveMap } from "./LiveMap.js";
import { NO_FLOWS, NO_WALKTHROUGH } from "./map-mode.js";
import { type MapStyle, MapStyleContext } from "./map-style.js";
import { pr847Doc } from "./test-graph.js";
import { tourStops } from "./walkthrough.js";
import { WalkthroughMap } from "./WalkthroughMap.js";

const noop = () => {};

// Read from disk: Vitest does not load CSS, so a `?raw` import of it would be empty.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const mapStylesCss = read("./map-styles.css");
const changeMapCss = read("../../../../packages/renderer/src/change-map.css");

const slot = (style: MapStyle, doc = pr847Doc()) =>
  renderToStaticMarkup(
    <MapStyleContext value={{ style, setStyle: noop, remembered: true }}>
      <ChangeMapSlot doc={doc} onOpenFile={noop} />
    </MapStyleContext>,
  );

describe("Live traffic", () => {
  it("draws the moving map with Traffic only and Pause motion", () => {
    const html = renderToStaticMarkup(
      <LiveMap doc={pr847Doc()} onOpenFile={noop} reducedMotion={false} />,
    );
    expect(html).toContain('class="cm cm-motion"');
    expect(html).toContain('class="cm-pulse"');
    expect(html).toMatch(
      /<button type="button" class="map-btn" aria-pressed="false">Traffic only<\/button>/,
    );
    expect(html).toMatch(/aria-pressed="false">Pause motion<\/button>/);
  });

  it("has nothing to pause with reduced motion, and keeps Traffic only", () => {
    const html = renderToStaticMarkup(<LiveMap doc={pr847Doc()} onOpenFile={noop} reducedMotion />);
    expect(html).not.toContain("Pause motion");
    expect(html).toContain("Traffic only");
  });

  it("offers no Traffic only when no edge carries traffic", () => {
    const doc = pr847Doc();
    if (doc.graph === undefined) throw new Error("graph");
    doc.graph.edges = doc.graph.edges.map((edge) => ({
      ...edge,
      emphasis: "normal",
      animated: false,
    }));
    const html = renderToStaticMarkup(
      <LiveMap doc={doc} onOpenFile={noop} reducedMotion={false} />,
    );
    expect(html).not.toContain("Traffic only");
  });
});

describe("Guided walkthrough", () => {
  const stops = () => {
    const graph = pr847Doc().graph;
    if (graph === undefined) throw new Error("graph");
    return tourStops(graph);
  };

  it("opens at the first stop, lit and zoomed, with Back off", () => {
    const html = renderToStaticMarkup(
      <WalkthroughMap doc={pr847Doc()} stops={stops()} onOpenFile={noop} reducedMotion={false} />,
    );
    expect(html).toContain("Stop 1 of 3");
    expect(html).toContain("A new way in");
    expect(html).toMatch(/data-node="page"[^>]*>|class="cm-node cm-added cm-wave-0 cm-focus"/);
    expect(html).toMatch(
      /<button type="button" class="map-btn" aria-disabled="true">Back<\/button>/,
    );
    expect(html).toContain(">Play tour</button>");
    expect(html).toMatch(/aria-label="Stop 1: A new way in" aria-current="step"/);
    expect(html).toMatch(/class="walk-pan" style="width:\d+px;transform:translate\(/);
  });

  it("offers no Play for a one-stop tour", () => {
    const html = renderToStaticMarkup(
      <WalkthroughMap
        doc={pr847Doc()}
        stops={stops().slice(0, 1)}
        onOpenFile={noop}
        reducedMotion={false}
      />,
    );
    expect(html).not.toContain("Play tour");
    expect(html).toContain("Stop 1 of 1");
  });

  it("still steps by hand with reduced motion, without Play", () => {
    const html = renderToStaticMarkup(
      <WalkthroughMap doc={pr847Doc()} stops={stops()} onOpenFile={noop} reducedMotion />,
    );
    expect(html).not.toContain("Play tour");
    expect(html).toContain(">Next stop</button>");
  });
});

describe("Flow playback", () => {
  const flows = () => pr847Doc().graph?.flows ?? [];

  it("opens at the first message, the rest ghosted", () => {
    const html = renderToStaticMarkup(
      <FlowPlayback doc={pr847Doc()} flows={flows()} onOpenFile={noop} reducedMotion={false} />,
    );
    expect(html).toContain("Step 1 of 4");
    expect(html.match(/class="seq-msg is-active/g)).toHaveLength(1);
    expect(html.match(/class="seq-msg is-future/g)).toHaveLength(3);
    expect(html).toContain('class="seq-token"');
    expect(html).toContain(">Play</button>");
    expect(html).toMatch(/aria-pressed="true"><bdi>Accepting an invitation<\/bdi>/);
  });

  it("opens fully played with reduced motion: every message shown, nothing to play", () => {
    const html = renderToStaticMarkup(
      <FlowPlayback doc={pr847Doc()} flows={flows()} onOpenFile={noop} reducedMotion />,
    );
    expect(html).toContain("All 4 steps played.");
    expect(html.match(/class="seq-msg is-past/g)).toHaveLength(4);
    expect(html).not.toContain("seq-token");
    expect(html).not.toContain(">Play</button>");
    expect(html).toMatch(
      /<button type="button" class="map-btn map-btn-primary" aria-disabled="true">Next<\/button>/,
    );
  });

  it("makes a column head a button when its node backs a PR file", () => {
    const html = renderToStaticMarkup(
      <FlowPlayback doc={pr847Doc()} flows={flows()} onOpenFile={noop} reducedMotion={false} />,
    );
    expect(html).toMatch(
      /<button type="button" class="seq-head-box" aria-label="InvitePage, opens web\/src\/pages\/InvitePage.tsx">/,
    );
  });
});

describe("the slot picks the style, and falls back", () => {
  it("plays the chosen style", () => {
    expect(slot("live")).toContain("cm-motion");
    expect(slot("walkthrough")).toContain("Stop 1 of 3");
    expect(slot("flows")).toContain("Step 1 of 4");
    expect(slot("flows")).toContain("click a column head to open its file");
    expect(slot("flows")).not.toContain('aria-label="Legend"');
  });

  it("shows Live traffic with a notice when the document has no walkthrough or flows", () => {
    const doc = pr847Doc();
    if (doc.graph === undefined) throw new Error("graph");
    doc.graph.walkthrough = undefined;
    doc.graph.flows = [];
    const walk = slot("walkthrough", doc);
    expect(walk).toContain(NO_WALKTHROUGH);
    expect(walk).toContain("cm-motion");
    const flows = slot("flows", doc);
    expect(flows).toContain(NO_FLOWS);
    expect(flows).toContain("cm-pulse");
  });

  it("says which style plays, on a button that opens the settings", () => {
    expect(slot("walkthrough")).toMatch(
      /aria-haspopup="dialog">Map style: Guided walkthrough<\/button>/,
    );
  });
});

/** The CSS outside every `@media (prefers-reduced-motion: no-preference)` block. */
const outsideNoPreference = (css: string): string => {
  let rest = css;
  let out = "";
  const marker = "@media (prefers-reduced-motion: no-preference)";
  for (let at = rest.indexOf(marker); at !== -1; at = rest.indexOf(marker)) {
    out += rest.slice(0, at);
    let depth = 0;
    let i = rest.indexOf("{", at);
    for (; i < rest.length; i += 1) {
      if (rest[i] === "{") depth += 1;
      if (rest[i] === "}" && --depth === 0) break;
    }
    rest = rest.slice(i + 1);
  }
  return out + rest;
};

/** Keyframes define motion but start none; only `animation`/`transition` declarations do. */
const motionDeclarations = (css: string): string[] =>
  (css.match(/(?:^|[;{\s])(?:animation|transition)(?:-name)?\s*:[^;]+/g) ?? [])
    .map((declaration) => declaration.trim().replace(/^[;{]\s*/, ""))
    .filter((declaration) => !/:\s*none\b/.test(declaration));

describe("reduced motion (stylesheets)", () => {
  it("starts no animation or transition in the map styles outside no-preference", () => {
    expect(motionDeclarations(outsideNoPreference(mapStylesCss))).toEqual([]);
  });

  it("does the same for the renderer's H4-6 motion", () => {
    const section = changeMapCss.slice(changeMapCss.indexOf("H4-6 (ADR 0035)"));
    expect(section.length).toBeGreaterThan(100);
    expect(motionDeclarations(outsideNoPreference(section))).toEqual([]);
  });

  it("hides the travelling dots unless motion is welcome", () => {
    expect(changeMapCss).toMatch(/\.cm-pulse \{\s*display: none;/);
    expect(mapStylesCss).toMatch(/\.seq-token \{\s*display: none;/);
  });
});
