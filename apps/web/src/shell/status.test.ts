import { describe, expect, it } from "vitest";
import { statusOf } from "./status.js";

describe("statusOf", () => {
  it("shows the PR state on GitHub before the viewer reviews", () => {
    expect(statusOf("open", null)).toEqual({ label: "Open", tone: "ok" });
    expect(statusOf("merged", null)).toEqual({ label: "Merged", tone: "low" });
    expect(statusOf("closed", null)).toEqual({ label: "Closed", tone: "low" });
  });

  it("shows the viewer's submitted review once there is one", () => {
    expect(statusOf("open", "approved")).toEqual({ label: "Approved", tone: "ok" });
    expect(statusOf("open", "changes_requested")).toEqual({
      label: "Changes requested",
      tone: "crit",
    });
    expect(statusOf("open", "commented")).toEqual({ label: "Commented", tone: "low" });
  });
});
