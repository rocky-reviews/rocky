import { describe, expect, it } from "vitest";
import { untilAborted } from "./ReviewProvider.js";

/**
 * P6-4: answers about an analysis that is no longer on screen are dropped. The provider runs
 * every decision and comment request through `untilAborted` with the signal of the analysis it
 * was made on; changing the analysis aborts that signal.
 */

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

describe("untilAborted", () => {
  it("passes an answer and an error through while the analysis is on screen", async () => {
    const live = new AbortController();
    await expect(untilAborted(Promise.resolve("ok"), live.signal)).resolves.toBe("ok");
    await expect(untilAborted(Promise.reject(new Error("x")), live.signal)).rejects.toThrow("x");
  });

  it("drops an answer or an error that arrives after the analysis changed", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      const scope = new AbortController();
      let answer!: () => void;
      const request = new Promise<string>((resolve, reject) => {
        answer = () => (outcome === "resolve" ? resolve("late") : reject(new Error("late")));
      });
      const guarded = untilAborted(request, scope.signal);
      scope.abort(); // another analysis is now on screen
      answer();
      expect(await settled(guarded)).toBe(false);
    }
  });
});
