/**
 * P10-1 (ADR 0043 S8): the two healthcheck scripts the images run (`HEALTHCHECK` in
 * deploy/Dockerfile). Plain Node, no dependencies: the distroless image has nothing else. They
 * exit 0 when healthy, 1 otherwise, and print nothing (a healthcheck's output lands in
 * `docker inspect`, which is not a log the operator reads).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const script = (name: string) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Asynchronous on purpose: the test's own HTTP server must keep answering while the child runs. */
const run = (name: string, env: Record<string, string>): Promise<Run> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script(name)], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

describe("server.mjs", () => {
  let server: Server;
  let port: number;
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== "/healthz") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status === 200, database: status === 200 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    port = address.port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("exits 0 on a 200 from /healthz and prints nothing", async () => {
    status = 200;
    expect(await run("server", { PORT: String(port) })).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("exits 1 on a 503 (database down) and prints nothing", async () => {
    status = 503;
    expect(await run("server", { PORT: String(port) })).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
  });

  it("exits 1 when nothing listens, on a bad PORT and on an empty one", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const address = closed.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await new Promise((resolve) => closed.close(resolve));
    expect(await run("server", { PORT: String(address.port) })).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
    expect((await run("server", { PORT: "not-a-port" })).status).toBe(1);
    expect((await run("server", { PORT: "" })).status).toBe(1);
  });
});

describe("worker.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rocky-healthcheck-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 on a fresh heartbeat", async () => {
    const file = join(dir, "beat");
    writeFileSync(file, new Date().toISOString());
    expect(await run("worker", { ROCKY_HEARTBEAT_FILE: file })).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("exits 1 on a stale heartbeat (older than 60 s)", async () => {
    const file = join(dir, "beat");
    writeFileSync(file, "stale");
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(file, old, old);
    expect(await run("worker", { ROCKY_HEARTBEAT_FILE: file })).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
  });

  it("exits 1 when the file is missing or the variable unset", async () => {
    expect((await run("worker", { ROCKY_HEARTBEAT_FILE: join(dir, "missing") })).status).toBe(1);
    expect((await run("worker", {})).status).toBe(1);
  });
});
