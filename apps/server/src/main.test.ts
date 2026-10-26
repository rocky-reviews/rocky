import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** main.ts as a process: boot failures and signals (review round 2, S2 and N4). */

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const ENV = {
  PATH: process.env["PATH"] ?? "",
  // Unroutable: neither test needs the database.
  DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
  HOST: "127.0.0.1",
};

describe("main.ts", () => {
  it("logs a non-config boot failure by code (EADDRINUSE) and exits 1", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", MAIN], {
        env: { ...ENV, PORT: String(port) },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status).toBe(1);
      const fatal = result.stdout
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l["msg"] === "server failed to start");
      expect(fatal).toMatchObject({ errorCode: "EADDRINUSE" });
      expect(result.stdout + result.stderr).not.toContain("nothing@127.0.0.1");
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 30_000);

  it("shuts down cleanly on SIGTERM, and a second signal does not break it (exit 0)", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN], {
      env: { ...ENV, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    await expect.poll(() => out.includes("server listening"), { timeout: 20_000 }).toBe(true);
    child.kill("SIGTERM");
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 30_000);
});
