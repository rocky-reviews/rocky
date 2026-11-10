import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@rocky-reviews/log";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "./config.js";
import { heartbeatFileFromEnv, startHeartbeat, type Heartbeat } from "./heartbeat.js";

/**
 * P10-1 (ADR 0043 S8): the worker's liveness signal for a container healthcheck. A file the
 * event loop refreshes; the healthcheck (`deploy/healthcheck/worker.mjs`) reads its mtime.
 */

const capture = () => {
  const out: Record<string, unknown>[] = [];
  const log = createLogger("worker-test", {
    destination: { write: (c: string) => void out.push(JSON.parse(c) as Record<string, unknown>) },
  });
  return { log, out };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("heartbeatFileFromEnv", () => {
  it("is off when unset or empty", () => {
    expect(heartbeatFileFromEnv({})).toBeUndefined();
    expect(heartbeatFileFromEnv({ ROCKY_HEARTBEAT_FILE: "" })).toBeUndefined();
  });

  it("takes an absolute path only", () => {
    expect(heartbeatFileFromEnv({ ROCKY_HEARTBEAT_FILE: "/tmp/rocky-worker-heartbeat" })).toBe(
      "/tmp/rocky-worker-heartbeat",
    );
    expect(() => heartbeatFileFromEnv({ ROCKY_HEARTBEAT_FILE: "heartbeat" })).toThrow(ConfigError);
    expect(() => heartbeatFileFromEnv({ ROCKY_HEARTBEAT_FILE: "./heartbeat" })).toThrow(
      ConfigError,
    );
  });
});

describe("startHeartbeat", () => {
  let dir: string;
  let heartbeat: Heartbeat | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rocky-heartbeat-"));
  });
  afterEach(() => {
    heartbeat?.stop();
    heartbeat = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the time at once, owner-only, and keeps refreshing it", async () => {
    const file = join(dir, "beat");
    const { log, out } = capture();
    heartbeat = startHeartbeat({ file, intervalMs: 20, log });
    await sleep(5);
    const first = readFileSync(file, "utf8");
    expect(new Date(first).getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await sleep(60);
    expect(readFileSync(file, "utf8")).not.toBe(first);
    expect(out).toEqual([]);
  });

  it("stops writing after stop()", async () => {
    const file = join(dir, "beat");
    heartbeat = startHeartbeat({ file, intervalMs: 10, log: capture().log });
    await sleep(5);
    heartbeat.stop();
    const stopped = readFileSync(file, "utf8");
    await sleep(40);
    expect(readFileSync(file, "utf8")).toBe(stopped);
  });

  it("refuses to follow a symlink at the path and logs the code once, not the path", async () => {
    const target = join(dir, "elsewhere");
    writeFileSync(target, "untouched");
    const file = join(dir, "beat");
    symlinkSync(target, file);
    const { log, out } = capture();
    heartbeat = startHeartbeat({ file, intervalMs: 10, log });
    await sleep(50);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: 40, errorCode: "ELOOP" });
    expect(JSON.stringify(out[0])).not.toContain(dir);
  });
});
