import { describe, expect, it } from "vitest";
import { timeAgo } from "./time.js";

const at = Date.parse("2026-10-25T12:00:00.000Z");

describe("timeAgo", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 min ago"],
    [12 * 60_000, "12 min ago"],
    [59 * 60_000, "59 min ago"],
    [60 * 60_000, "1 h ago"],
    [23 * 3_600_000, "23 h ago"],
    [24 * 3_600_000, "1 day ago"],
    [3 * 24 * 3_600_000, "3 days ago"],
  ])("%i ms later reads %s", (elapsed, text) => {
    expect(timeAgo("2026-10-25T12:00:00.000Z", at + elapsed)).toBe(text);
  });

  it("treats a clock behind the update as just now", () => {
    expect(timeAgo("2026-10-25T12:00:00.000Z", at - 5_000)).toBe("just now");
  });

  it("does not echo a bad timestamp", () => {
    expect(timeAgo("<b>soon</b>", at)).toBe("at an unknown time");
  });
});
