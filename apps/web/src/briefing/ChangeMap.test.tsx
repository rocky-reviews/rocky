import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MapBoundary } from "./ChangeMap.js";

describe("MapBoundary (the renderer fails closed)", () => {
  it("turns a render error into the unavailable panel with a fixed code", () => {
    expect(MapBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new MapBoundary({ children: <p>map</p> });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain("Change map unavailable");
    expect(html).toContain("<code>CM-RENDER</code>");
    expect(html).not.toContain("map</p>");
  });

  it("renders its children while nothing failed", () => {
    expect(renderToStaticMarkup(<MapBoundary>{<p>map</p>}</MapBoundary>)).toBe("<p>map</p>");
  });
});
