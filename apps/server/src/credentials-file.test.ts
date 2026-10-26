import { randomBytes, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkCredentialsTarget,
  CredentialsFileError,
  credentialsEnvText,
  writeCredentialsOnce,
  type GitHubAppSecrets,
} from "./credentials-file.js";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

const secrets = (): GitHubAppSecrets => ({
  appId: 4242,
  slug: "rocky-reviews-test",
  clientId: "Iv23liABCDEF12345678",
  clientSecret: randomBytes(20).toString("hex"),
  privateKeyPem: PEM,
  webhookSecret: randomBytes(32).toString("hex"),
  webhookSecretSource: "github",
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rocky-creds-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("credentialsEnvText", () => {
  it("round-trips through Node's own .env parser exactly", () => {
    const s = secrets();
    expect({ ...parseEnv(credentialsEnvText(s)) }).toStrictEqual({
      GITHUB_APP_ID: "4242",
      GITHUB_APP_SLUG: s.slug,
      GITHUB_APP_CLIENT_ID: s.clientId,
      GITHUB_APP_CLIENT_SECRET: s.clientSecret,
      GITHUB_APP_PRIVATE_KEY: s.privateKeyPem,
      GITHUB_WEBHOOK_SECRET: s.webhookSecret,
    });
  });

  it("single-quotes every value (review round 1, item 6)", () => {
    const text = credentialsEnvText(secrets());
    const assignments = text.split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    expect(assignments.map((l) => l.split("=")[0])).toStrictEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ]);
    for (const line of assignments) expect(line, line.slice(0, 20)).toMatch(/^[A-Z_]+='/);
    expect(text).not.toContain('"');
  });

  it("reads back identically through node --env-file and a POSIX shell's source, PEM included", async () => {
    const s = secrets();
    const file = join(dir, "github-app.env");
    await writeCredentialsOnce(file, credentialsEnvText(s));
    const run = promisify(execFile);
    const keys = [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
    ];
    const expected = ["4242", s.slug, s.clientId, s.clientSecret, s.webhookSecret, PEM];
    const viaNode = await run(process.execPath, [
      `--env-file=${file}`,
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map((k) => process.env[k])))`,
    ]);
    expect(JSON.parse(viaNode.stdout)).toStrictEqual(expected);
    const viaShell = await run("/bin/sh", [
      "-c",
      `set -eu; . "$1"; printf '%s\\0' ${keys.map((k) => `"$${k}"`).join(" ")}`,
      "sh",
      file,
    ]);
    expect(viaShell.stdout.split("\0").slice(0, -1)).toStrictEqual(expected);
  });

  it("omits the slug when GitHub returned none, and still writes everything else", () => {
    const s = { ...secrets(), slug: undefined };
    const env = parseEnv(credentialsEnvText(s));
    expect(env["GITHUB_APP_SLUG"]).toBeUndefined();
    expect(env["GITHUB_APP_CLIENT_SECRET"]).toBe(s.clientSecret);
    expect(env["GITHUB_APP_PRIVATE_KEY"]).toBe(PEM);
  });

  it("refuses shell-active characters in any value", () => {
    for (const c of ["!", "*", "?", ";", "^", ",", "'", "$", "`", "\\", "#", " ", "&", "|"]) {
      expect(
        () => credentialsEnvText({ ...secrets(), clientSecret: `abc${c}def0123456789abcdef` }),
        c,
      ).toThrow(CredentialsFileError);
    }
  });

  it("refuses values that could inject extra lines or quotes into the env file", () => {
    for (const bad of [
      { slug: "x\nNODE_OPTIONS=--require=/tmp/evil" },
      { clientId: 'Iv1."' },
      { clientSecret: "a b" },
      { webhookSecret: "x".repeat(40) + "\nX=1" },
      { webhookSecret: "x".repeat(40) + '"' },
      { privateKeyPem: PEM + '"\nX=1\n' },
      { appId: -1 },
    ]) {
      expect(() => credentialsEnvText({ ...secrets(), ...bad } as GitHubAppSecrets)).toThrow(
        CredentialsFileError,
      );
    }
  });
});

describe("writeCredentialsOnce", () => {
  it("writes the file with mode 0600 in a 0700 directory it creates", async () => {
    const file = join(dir, "nested", "github-app.env");
    const text = credentialsEnvText(secrets());
    await writeCredentialsOnce(file, text);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, "utf8")).toBe(text);
    // No temporary file left behind.
    expect(await readdir(join(dir, "nested"))).toStrictEqual(["github-app.env"]);
  });

  it("refuses to overwrite an existing file and leaves it untouched", async () => {
    const file = join(dir, "github-app.env");
    await writeFile(file, "KEEP=1\n", { mode: 0o600 });
    await expect(writeCredentialsOnce(file, "NEW=1\n")).rejects.toMatchObject({ reason: "exists" });
    expect(await readFile(file, "utf8")).toBe("KEEP=1\n");
    expect(await readdir(dir)).toStrictEqual(["github-app.env"]);
  });

  it("refuses a (dangling) symlink at the target instead of following it", async () => {
    const file = join(dir, "github-app.env");
    const elsewhere = join(dir, "elsewhere.env");
    await symlink(elsewhere, file);
    await expect(writeCredentialsOnce(file, "X=1\n")).rejects.toMatchObject({ reason: "exists" });
    await expect(lstat(elsewhere)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets exactly one of several concurrent writers win", async () => {
    const file = join(dir, "github-app.env");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => writeCredentialsOnce(file, `N=${i}\n`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readdir(dir)).toStrictEqual(["github-app.env"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses a group- or world-writable directory, and relative paths", async () => {
    const open = join(dir, "open");
    await mkdir(open, { mode: 0o700 });
    await chmod(open, 0o777);
    await expect(writeCredentialsOnce(join(open, "f.env"), "X=1\n")).rejects.toMatchObject({
      reason: "unsafe_directory",
    });
    await chmod(open, 0o770);
    await expect(writeCredentialsOnce(join(open, "f.env"), "X=1\n")).rejects.toMatchObject({
      reason: "unsafe_directory",
    });
    await expect(writeCredentialsOnce("relative/f.env", "X=1\n")).rejects.toMatchObject({
      reason: "not_absolute",
    });
  });

  it("refuses to write on Windows, where file modes do not protect the file (item 7)", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      const file = join(dir, "github-app.env");
      await expect(writeCredentialsOnce(file, "X='1'\n")).rejects.toMatchObject({
        reason: "unsupported_platform",
      });
      await expect(checkCredentialsTarget(file)).rejects.toMatchObject({
        reason: "unsupported_platform",
      });
      expect(await readdir(dir)).toStrictEqual([]);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("checkCredentialsTarget answers before anything is written", async () => {
    const file = join(dir, "github-app.env");
    await expect(checkCredentialsTarget(file)).resolves.toBeUndefined();
    await writeFile(file, "X=1\n");
    await expect(checkCredentialsTarget(file)).rejects.toMatchObject({ reason: "exists" });
  });

  it("never puts the contents in an error", async () => {
    const file = join(dir, "github-app.env");
    await writeFile(file, "X=1\n");
    const s = secrets();
    const error = await writeCredentialsOnce(file, credentialsEnvText(s)).catch((e: unknown) => e);
    expect(String(error) + JSON.stringify(error)).not.toContain(s.clientSecret);
  });
});
