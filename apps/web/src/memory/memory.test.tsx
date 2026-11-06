import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryPagePath, memoryRefFromPath, pageFor } from "../route.js";
import {
  MEMORY_FIXTURE,
  MEMORY_FIXTURE_NOW,
  MEMORY_FIXTURE_REPO,
  memoryEntryId,
} from "./fixtures.js";
import { Memory } from "./Memory.js";
import {
  counts,
  coversLabel,
  earlierVersions,
  linesLabel,
  NO_MEMORY_FILTER,
  visibleEntries,
} from "./memory-model.js";
import {
  createFixtureMemorySource,
  createHttpMemorySource,
  MemoryLoadError,
  memoryApiPath,
  parseMemoryList,
} from "./memory-source.js";

/**
 * P8-3 (ADR 0039): the memory page's address, model, sources and static render. The
 * interactions (edit, switch, delete, the repository switch, export) run in Playwright
 * (`e2e/memory.e2e.spec.ts`), the screenshots in `e2e/memory.visual.spec.ts`.
 */

const NOW = Date.parse(MEMORY_FIXTURE_NOW);
const data = parseMemoryList(MEMORY_FIXTURE);
const repo = { owner: MEMORY_FIXTURE_REPO.owner, repo: MEMORY_FIXTURE_REPO.name };

describe("the memory page's address", () => {
  it("is /:owner/:repo/memory, from the server unless the fixture is asked for (dev and tests)", () => {
    expect(pageFor("/acme/rocky-app/memory", "", { fixtures: true })).toEqual({
      kind: "memory",
      source: "server",
      repo: { owner: "acme", repo: "rocky-app" },
    });
    expect(
      pageFor("/acme/rocky-app/memory/", "?source=fixture&as=member", { fixtures: true }),
    ).toEqual({
      kind: "memory",
      source: "fixture",
      repo: { owner: "acme", repo: "rocky-app" },
      canEdit: false,
    });
    expect(pageFor("/acme/rocky-app/memory", "?source=fixture", { fixtures: false })).toMatchObject(
      {
        source: "server",
      },
    );
  });

  it("refuses names GitHub would not accept", () => {
    for (const path of ["/-acme/x/memory", "/acme/../memory", "/acme/a%2Fb/memory", "/acme/memory"])
      expect(memoryRefFromPath(path), path).toBeNull();
    expect(memoryPagePath({ owner: "acme", repo: "rocky-app" })).toBe("/acme/rocky-app/memory");
    expect(memoryApiPath({ owner: "acme", repo: ".." })).toBeNull();
    expect(memoryApiPath({ owner: "acme", repo: "rocky.app" })).toBe(
      "/api/repos/acme/rocky.app/memory",
    );
  });
});

describe("the model", () => {
  it("shows current entries by default, earlier versions on request, by kind", () => {
    expect(visibleEntries(data.entries, NO_MEMORY_FILTER).map((e) => e.id)).not.toContain(
      memoryEntryId(3),
    );
    expect(visibleEntries(data.entries, { kind: null, history: true })).toHaveLength(6);
    expect(
      visibleEntries(data.entries, { kind: "dismissal", history: false }).map((e) => e.kind),
    ).toEqual(["dismissal", "dismissal", "dismissal"]);
    expect(counts(data.entries)).toEqual({ current: 5, off: 1, history: 1 });
  });

  it("counts the earlier versions a delete takes with it", () => {
    expect(earlierVersions(data.entries, memoryEntryId(2))).toBe(1);
    expect(earlierVersions(data.entries, memoryEntryId(1))).toBe(0);
  });

  it("labels lines and what a dismissal covers", () => {
    expect(linesLabel({ start: 7, end: 7 })).toBe("line 7");
    expect(linesLabel({ start: 41, end: 48 })).toBe("lines 41–48");
    const byId = (n: number) => {
      const found = data.entries.find((e) => e.id === memoryEntryId(n));
      if (found === undefined) throw new Error(`no entry ${n}`);
      return found;
    };
    expect(coversLabel(byId(1))).toBe("covers up to medium");
    expect(coversLabel(byId(5))).toBe("covers up to medium");
    expect(coversLabel(byId(6))).toBe("covers up to high");
    expect(coversLabel(byId(2))).toBeNull();
  });
});

describe("Memory (static render)", () => {
  const render = (canEdit = true) =>
    renderToStaticMarkup(
      <Memory
        data={{ ...data, canEdit }}
        now={NOW}
        mode="light"
        onToggleMode={() => undefined}
        source={createFixtureMemorySource()}
        repo={repo}
        onReload={async () => undefined}
      />,
    );

  it("shows each entry's evidence, source PR, confidence, last use and who taught it", () => {
    const html = render();
    expect(html).toContain("src/jobs/billing/retry-unpaid.ts");
    expect(html).toContain("lines 41–48");
    expect(html).toContain("9b4e1d7");
    expect(html).toContain('href="https://github.com/acme/rocky-app/pull/812"');
    expect(html).toContain("90%");
    expect(html).toContain("32 min ago");
    expect(html).toContain("never");
    expect(html).toContain("dana-k");
    expect(html).toContain("former member");
    expect(html).toContain("Learned from a review");
    expect(html).toContain("Written by a member");
    expect(html).toContain("Switched off");
  });

  it("renders entry text as text: markdown and HTML in it stay characters", () => {
    const html = render();
    expect(html).toContain("&lt;audit&gt; helper (see `log()` | **ids only**)");
    expect(html).not.toContain("<audit>");
    expect(html).not.toContain("<strong>");
  });

  it("gives an admin the controls, and a member none of them", () => {
    const admin = render(true);
    expect(admin).toContain(">Edit</button>");
    expect(admin).toContain(">Switch off</button>");
    expect(admin).toContain(">Switch on</button>");
    expect(admin).toContain(">Delete…</button>");
    expect(admin).toContain('role="switch"');
    const member = render(false);
    for (const control of [">Edit</button>", "Switch off", ">Delete…</button>", 'role="switch"'])
      expect(member).not.toContain(control);
    expect(member).toContain("Only admins and owners can change it.");
  });

  it("offers the export as a download of context.md from the server", () => {
    const html = render(false);
    expect(html).toContain('href="/api/repos/acme/rocky-app/memory/export"');
    expect(html).toContain('download="context.md"');
  });

  it("says when memory is off for the repository, and when there is nothing yet", () => {
    const off = renderToStaticMarkup(
      <Memory
        data={{ ...data, repository: { ...data.repository, memoryEnabled: false }, entries: [] }}
        now={NOW}
        mode="dark"
        onToggleMode={() => undefined}
        source={createFixtureMemorySource()}
        repo={repo}
        onReload={async () => undefined}
      />,
    );
    expect(off).toContain("Memory is off.");
    expect(off).toContain("hasn&#x27;t learned anything");
  });
});

describe("parseMemoryList", () => {
  it("refuses data that is not the wire format", () => {
    for (const bad of [null, {}, { ...MEMORY_FIXTURE, entries: [{ id: "x" }] }])
      expect(() => parseMemoryList(bad)).toThrow(MemoryLoadError);
  });
});

describe("the HTTP source", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (routes: Record<string, { status: number; body?: unknown }>) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const answer = routes[`${init?.method ?? "GET"} ${url}`];
      if (answer === undefined) throw new Error(`unexpected ${url}`);
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
      });
    });
    return calls;
  };
  const session = { status: 200, body: { authenticated: true, csrfToken: "tok" } };
  const base = "/api/repos/acme/rocky-app/memory";
  const id = memoryEntryId(1);

  it("loads, and says why it could not", async () => {
    respond({ [`GET ${base}`]: { status: 200, body: MEMORY_FIXTURE } });
    expect(await createHttpMemorySource().load(repo)).toEqual(MEMORY_FIXTURE);
    for (const [status, reason] of [
      [401, "signed_out"],
      [404, "not_found"],
      [503, "unavailable"],
      [500, "failed"],
    ] as const) {
      respond({ [`GET ${base}`]: { status } });
      await expect(createHttpMemorySource().load(repo)).rejects.toMatchObject({ reason });
    }
  });

  it("sends every change with the session's CSRF token, to the entry's route", async () => {
    const calls = respond({
      "GET /api/session": session,
      [`POST ${base}/entries/${id}/edit`]: { status: 200, body: {} },
      [`PUT ${base}/entries/${id}/disabled`]: { status: 200, body: {} },
      [`DELETE ${base}/entries/${id}`]: { status: 200, body: { deleted: 1 } },
      [`PUT ${base}/enabled`]: { status: 200, body: {} },
    });
    const source = createHttpMemorySource();
    expect(
      await source.edit(repo, id, { kind: "dismissal", text: "x", reason: "intentional" }),
    ).toEqual({ kind: "ok" });
    expect(await source.setDisabled(repo, id, true)).toEqual({ kind: "ok" });
    expect(await source.remove(repo, id)).toEqual({ kind: "ok" });
    expect(await source.setEnabled(repo, false)).toEqual({ kind: "ok" });
    const changes = calls.filter((c) => c.init?.method !== undefined);
    expect(changes).toHaveLength(4);
    for (const c of changes) expect(c.init?.headers).toMatchObject({ "x-rocky-csrf": "tok" });
    expect(JSON.parse(String(changes[0]?.init?.body))).toEqual({
      kind: "dismissal",
      text: "x",
      reason: "intentional",
    });
    expect(JSON.parse(String(changes[1]?.init?.body))).toEqual({ disabled: true });
    expect(JSON.parse(String(changes[3]?.init?.body))).toEqual({ enabled: false });
  });

  it("maps refusals to fixed outcomes and never sends an id that is not a uuid", async () => {
    const source = createHttpMemorySource();
    for (const [status, body, kind] of [
      [400, { error: "invalid_entry_text" }, "invalid_text"],
      [409, { error: "already_superseded" }, "conflict"],
      [403, { error: "forbidden" }, "forbidden"],
      [404, { error: "not_found" }, "not_found"],
      [500, null, "error"],
    ] as const) {
      respond({
        "GET /api/session": session,
        [`PUT ${base}/entries/${id}/disabled`]: { status, body },
      });
      expect(await source.setDisabled(repo, id, true)).toEqual({ kind });
    }
    respond({});
    expect(await source.remove(repo, "../../enabled")).toEqual({ kind: "not_found" });
  });
});

describe("the fixture source", () => {
  it("applies an edit as a new version, and a delete with the earlier versions", async () => {
    const source = createFixtureMemorySource();
    expect(
      await source.edit(repo, memoryEntryId(1), {
        kind: "convention",
        text: "Log it.",
        reason: null,
      }),
    ).toEqual({ kind: "ok" });
    let view = parseMemoryList(await source.load(repo));
    const edited = view.entries[0];
    if (edited === undefined) throw new Error("no entry");
    expect(edited).toMatchObject({ kind: "convention", origin: "member", text: "Log it." });
    expect(view.entries.find((e) => e.id === memoryEntryId(1))?.supersededBy).toBe(edited.id);
    await source.remove(repo, edited.id);
    view = parseMemoryList(await source.load(repo));
    expect(view.entries.map((e) => e.id)).not.toContain(memoryEntryId(1));
  });

  it("refuses every change in a member's view", async () => {
    const source = createFixtureMemorySource({ canEdit: false });
    expect(await source.setEnabled(repo, false)).toEqual({ kind: "forbidden" });
    expect(parseMemoryList(await source.load(repo)).canEdit).toBe(false);
  });
});
