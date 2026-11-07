import { ForgeReadError, type ArchiveFile, type CodeSession } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { parseGitHubAppAuth } from "./app-auth.js";
import { githubEndpoints } from "./app-manifest.js";
import { CODE_TOKEN_PERMISSIONS, createGitHubForge } from "./repositories.js";
import { readTar } from "./tar.js";
import { fakeBlobSha, fakeGitHubApi, FIXTURE_APP_ID, tarGz, testAppKeys } from "./testing.js";

/**
 * P9-1 (ADR 0040 §5): reading a repository's code for the index. A token scoped to the one
 * repository with `contents: read` only; the tree, single blobs, and one archive download whose
 * redirect is followed without the token. Served by `fakeGitHubApi`; nothing reaches GitHub.
 */

const keys = testAppKeys();
const auth = parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem });
const { api } = githubEndpoints({});
const REF = { installationId: 4242, repositoryId: 77 };
const HEAD = "c".repeat(40);
const FILES = {
  "src/a.ts": "export const a = 1;\n",
  "src/deep/b.py": "def b():\n    return 2\n",
  "README.md": "# Readme\n",
};

const setup = () => {
  const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  github.install(4242, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(4242, { id: 77, fullName: "acme/api" });
  github.putCode(77, HEAD, FILES, { branch: "main" });
  const forge = createGitHubForge({
    auth,
    api,
    clock: { now: () => new Date() },
    fetch: github.fetch,
  });
  return { github, forge };
};

const openCode = async (forge: ReturnType<typeof createGitHubForge>): Promise<CodeSession> => {
  const session = await forge.openCode(REF);
  if (session === null) throw new Error("expected a code session");
  return session;
};

const collect = async (files: AsyncIterable<ArchiveFile>): Promise<ArchiveFile[]> => {
  const out: ArchiveFile[] = [];
  for await (const file of files) out.push(file);
  return out;
};

const failure = async (promise: Promise<unknown>): Promise<ForgeReadError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForgeReadError) return error;
    throw error;
  }
  throw new Error("expected a ForgeReadError");
};

const stream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));

describe("code sessions: contents read only, one repository, revoked on close", () => {
  it("mints a contents-only token and revokes it on close", async () => {
    const { github, forge } = setup();
    const session = await openCode(forge);
    expect(CODE_TOKEN_PERMISSIONS).toEqual({ contents: "read" });
    expect(github.tokens.mints).toEqual([
      { installationId: 4242, body: { repository_ids: [77], permissions: { contents: "read" } } },
    ]);
    expect(await session.branchHead("main")).toBe(HEAD);
    await session.close();
    await session.close();
    expect(github.tokens.revoked).toBe(1);
    await expect(session.branchHead("main")).rejects.toThrow(/closed/);
  });

  it("reports the repository's size in KiB, or null when GitHub gives none (P9-1 fix round)", async () => {
    const { github, forge } = setup();
    const session = await openCode(forge);
    expect(await session.repositorySizeKb()).toBe(1);
    github.putCode(77, HEAD, FILES, { branch: "main", sizeKb: 123_456 });
    expect(await session.repositorySizeKb()).toBe(123_456);
    github.putCode(77, HEAD, FILES, { branch: "main", sizeKb: null });
    expect(await session.repositorySizeKb()).toBeNull();
    github.failRoute("repository", 502);
    await expect(session.repositorySizeKb()).rejects.toThrow(ForgeReadError);
    await session.close();
  });

  it("is null when the repository is not the installation's", async () => {
    const { forge } = setup();
    expect(await forge.openCode({ installationId: 4242, repositoryId: 999 })).toBeNull();
  });
});

describe("branchHead, readTree, readBlob", () => {
  it("reads the head of a branch, null for one that does not exist", async () => {
    const { forge } = setup();
    const session = await openCode(forge);
    expect(await session.branchHead("main")).toBe(HEAD);
    expect(await session.branchHead("feature/none")).toBeNull();
    await expect(session.branchHead("bad branch")).rejects.toThrow(/invalid branch/);
    await session.close();
  });

  it("lists regular files with blob ids and sizes; no symlinks, submodules or directories", async () => {
    const { forge } = setup();
    const session = await openCode(forge);
    const tree = await session.readTree(HEAD);
    expect(tree?.truncated).toBe(false);
    expect(tree?.entries.map((e) => e.path).sort()).toEqual(Object.keys(FILES).sort());
    const a = tree?.entries.find((e) => e.path === "src/a.ts");
    const bytes = new TextEncoder().encode(FILES["src/a.ts"]);
    expect(a).toEqual({ path: "src/a.ts", blobSha: fakeBlobSha(bytes), size: bytes.length });
    expect(await session.readTree("d".repeat(40))).toBeNull();
    await session.close();
  });

  it("passes on GitHub's truncated flag", async () => {
    const { github, forge } = setup();
    github.putCode(77, "e".repeat(40), FILES, { truncated: true });
    const session = await openCode(forge);
    expect((await session.readTree("e".repeat(40)))?.truncated).toBe(true);
    await session.close();
  });

  it("reads one blob, too_large past the cap, not_found for an unknown one", async () => {
    const { forge } = setup();
    const session = await openCode(forge);
    const bytes = new TextEncoder().encode(FILES["src/a.ts"]);
    const sha = fakeBlobSha(bytes);
    expect(await session.readBlob(sha, { maxBytes: 1024 })).toEqual({ kind: "ok", bytes });
    expect(await session.readBlob(sha, { maxBytes: 4 })).toEqual({ kind: "too_large" });
    expect(await session.readBlob("0".repeat(40), { maxBytes: 1024 })).toEqual({
      kind: "not_found",
    });
    await expect(session.readBlob("nope", { maxBytes: 1 })).rejects.toThrow(/invalid sha/);
    await session.close();
  });

  it("maps a server error to a transient read failure", async () => {
    const { github, forge } = setup();
    github.failRoute("tree", 502);
    const session = await openCode(forge);
    const error = await failure(session.readTree(HEAD));
    expect(error.code).toBe("forge_http_502");
    expect(error.transient).toBe(true);
    await session.close();
  });
});

describe("readArchive", () => {
  it("streams the wanted files of one download, without sending the token to codeload", async () => {
    const { github, forge } = setup();
    const session = await openCode(forge);
    const files = await collect(
      session.readArchive(HEAD, { maxFileBytes: 1024, wanted: (path) => path !== "README.md" }),
    );
    expect(
      files.map((f) => [f.path, new TextDecoder().decode(f.bytes ?? new Uint8Array())]),
    ).toEqual([
      ["src/a.ts", FILES["src/a.ts"]],
      ["src/deep/b.py", FILES["src/deep/b.py"]],
    ]);
    expect(github.archiveRequests).toEqual([{ authorized: false }]);
    await session.close();
  });

  it("names files over maxFileBytes without reading them", async () => {
    const { forge } = setup();
    const session = await openCode(forge);
    const files = await collect(
      session.readArchive(HEAD, { maxFileBytes: 12, wanted: () => true }),
    );
    expect(files.find((f) => f.path === "src/a.ts")).toEqual({
      path: "src/a.ts",
      size: FILES["src/a.ts"].length,
      bytes: null,
    });
    expect(files.find((f) => f.path === "README.md")?.bytes).not.toBeNull();
    await session.close();
  });

  it("refuses a redirect to a host other than codeload or the API's own", async () => {
    const { forge, github } = setup();
    const evil = createGitHubForge({
      auth,
      api,
      clock: { now: () => new Date() },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith(`/tarball/${HEAD}`)) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/steal" },
          });
        }
        return github.fetch(input, init);
      }) as typeof fetch,
    });
    void forge;
    const session = await openCode(evil);
    const error = await failure(
      collect(session.readArchive(HEAD, { maxFileBytes: 1, wanted: () => true })),
    );
    expect(error.code).toBe("forge_invalid_response");
    await session.close();
  });
});

describe("readTar: untrusted archives", () => {
  const limits = {
    maxFileBytes: 1024,
    wanted: () => true,
    maxTotalBytes: 1 << 20,
    maxEntries: 100,
  };

  it("yields regular files only, under the top directory, and skips links and bad paths", async () => {
    const archive = tarGz("acme-api-ccccccc", [
      { path: "ok.ts", content: "a" },
      { path: "dir", type: "dir" },
      { path: "link.ts", type: "symlink" },
      { path: "hard.ts", type: "hardlink" },
      { path: "a/../escape.ts", content: "x" },
      { path: `${"long/".repeat(30)}name.ts`, content: "long" },
    ]);
    const files = await collect(readTar(stream(archive), limits));
    expect(files.map((f) => f.path)).toEqual(["ok.ts", `${"long/".repeat(30)}name.ts`]);
  });

  it("refuses an archive over its byte or entry cap, and one with a bad checksum", async () => {
    const big = tarGz("t", [{ path: "a.ts", content: "x".repeat(4000) }]);
    await expect(collect(readTar(stream(big), { ...limits, maxTotalBytes: 2048 }))).rejects.toThrow(
      ForgeReadError,
    );
    const many = tarGz(
      "t",
      Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts`, content: "x" })),
    );
    await expect(collect(readTar(stream(many), { ...limits, maxEntries: 5 }))).rejects.toThrow(
      ForgeReadError,
    );
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const raw = new Uint8Array(gunzipSync(tarGz("t", [{ path: "a.ts", content: "x" }])));
    raw[512 * 3] = (raw[512 * 3] ?? 0) ^ 0xff;
    await expect(collect(readTar(stream(new Uint8Array(gzipSync(raw))), limits))).rejects.toThrow(
      ForgeReadError,
    );
  });

  it("refuses an archive cut short", async () => {
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const raw = new Uint8Array(
      gunzipSync(tarGz("t", [{ path: "a.ts", content: "x".repeat(900) }])),
    );
    const cut = raw.subarray(0, 512 * 4 + 100);
    await expect(collect(readTar(stream(new Uint8Array(gzipSync(cut))), limits))).rejects.toThrow(
      ForgeReadError,
    );
  });
});
