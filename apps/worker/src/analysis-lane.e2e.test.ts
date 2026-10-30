import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Forge, ForgeDiff, RepositorySession } from "@rocky-reviews/core";
import { scriptedRoles, type Script, type ScriptedCall } from "@rocky-reviews/core/testing";
import {
  approveAnalysisOverLimit,
  createDb,
  enqueueAnalysis,
  type ClaimedAnalysis,
  type Db,
} from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import { llmConfigFromEnv, usageTargetsFor } from "@rocky-reviews/llm";
import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalysis, type AnalysisRun, type AnalysisRunnerDeps } from "./analysis.js";
import { createAnalysisLane, type AnalysisLane } from "./analysis-lane.js";

/**
 * P4-6 end to end (ADR 0017): the analysis queue lane against real Postgres, the worker login,
 * the real `runAnalysis` and pipeline, a scripted model (no network, no spending) and a fake
 * forge whose diff reads the test releases step by step. Time is a fake clock: one step is one
 * "analysis duration"; every analysis started in a step finishes at its end, so the order in
 * which analyses start is deterministic and is what the criteria are about:
 *
 * - a 200k-token pull request waits for a person, and no model is called (criterion 1);
 * - one org with 50 pull requests waiting cannot starve another (criterion 2, the load test).
 */

const TITLE = "Approve me: title-marker-4417";
const BASE = Date.parse("2026-10-27T12:00:00Z");
const STEP_MS = 60_000;

let pgs: TestPostgres;
let superuser: pg.Pool;
let worker: Db;
let A: SeededOrg;
let B: SeededOrg;
const orgByInstallation = new Map<number, "A" | "B">();

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  worker = createDb({ connectionString: pgs.workerUrl, max: 6 });
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 91 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 92 }));
  orgByInstallation.set(91, "A").set(92, "B");
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await superuser?.end();
  await pgs?.stop();
});

beforeEach(async () => {
  await superuser.query(
    `update analyses set status = 'failed', error_code = 'test_reset', completed_at = now(),
            lease_id = null, lease_until = null
      where status in ('queued', 'running', 'awaiting_approval')`,
  );
});

// --- Fixtures -----------------------------------------------------------------------------------

const addedFile = (path: string, lines: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");

const SMALL_DIFF = addedFile("src/util/format.ts", [
  "export const pad = (s: string) => s.padStart(2, '0');",
]);

/** About 600 000 characters of code over 4 files: an estimate above 200 000 tokens. */
const hugeDiff = (fill: string): string =>
  Array.from({ length: 4 }, (_, f) =>
    addedFile(
      `src/bulk-marker/part${f}.ts`,
      Array.from({ length: 1_875 }, (_, i) => `export const v${f}_${i} = "${fill.repeat(56)}";`),
    ),
  ).join("\n");

const diffOf = (text: string): ForgeDiff => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: false,
    truncation: null,
  };
};

/** A well-behaved model for any diff: every file normal, no findings, a briefing that fits. */
const genericScript: Script = (call: ScriptedCall) => {
  if (call.role === "triage") {
    return {
      value: {
        score: 30,
        level: "normal",
        reviewMinutes: 2,
        reason: "Reason.",
        whatChanged: "What changed.",
        whyThisLevel: "Why.",
        flags: [],
      },
    };
  }
  if (call.role === "review" && call.part("file_path") !== undefined) {
    return { value: { findings: [] } };
  }
  if (call.role === "review") {
    const files = JSON.parse(call.part("triage") ?? "[]") as { path: string }[];
    return {
      value: {
        summary: "Small changes.",
        verdict: { level: "low", reason: "Small change." },
        reviewPath: files.map((file) => ({ path: file.path, why: "Next." })),
        checkedOk: [],
      },
    };
  }
  return {
    value: {
      lanes: [{ id: "api", label: "API", order: 0 }],
      nodes: [{ id: "n1", lane: "api", kind: "ui", delta: "added", label: "Format" }],
    },
  };
};

let nextNumber = 1;
let nextHead = 1;

/**
 * `n` new pull requests of the org, each with one head revision and a queued analysis (in
 * order); every head's diff is `diffFor(head)`.
 */
const queuePullRequests = async (org: SeededOrg, n: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const head = (nextHead++).toString(16).padStart(40, "0");
    ids.push(
      await worker.withOrg(org.orgId, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `with pr as (
             insert into pull_requests
               (repo_id, number, title, author_login, state, head_sha, base_sha, opened_at)
             values ($1, $2, $3, 'alice', 'open', $4, $5, now()) returning id)
           insert into pr_revisions (pull_request_id, head_sha, base_sha)
           select id, $4, $5 from pr returning id`,
          [org.repoId, 1000 + nextNumber++, TITLE, head, "b".repeat(40)],
        );
        return enqueueAnalysis(tx, rows[0]!.id);
      }),
    );
  }
  return ids;
};

/** A new head revision of an existing pull request, queued (a push): the PR's head moves. */
const push = async (org: SeededOrg, analysisId: string): Promise<string> => {
  const head = (nextHead++).toString(16).padStart(40, "0");
  return worker.withOrg(org.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string; pull_request_id: string }>(
      `insert into pr_revisions (pull_request_id, head_sha, base_sha)
       select r.pull_request_id, $2, $3 from analyses a
         join pr_revisions r on r.org_id = a.org_id and r.id = a.revision_id
        where a.id = $1
       returning id, pull_request_id`,
      [analysisId, head, "b".repeat(40)],
    );
    await tx.query("update pull_requests set head_sha = $2 where id = $1", [
      rows[0]!.pull_request_id,
      head,
    ]);
    return enqueueAnalysis(tx, rows[0]!.id);
  });
};

interface Gate {
  reached: boolean;
  open: () => void;
  opened: Promise<void>;
}

interface Started {
  readonly org: "A" | "B";
  readonly step: number;
}

/**
 * A read-only forge whose diff reads wait until the test releases them, so the test decides when
 * each analysis "finishes". It records which org's analysis started in which step. Runs finish in
 * the order the lane handed them out (`claimed`), not the order their forge calls happened to
 * reach it: concurrent runs race to `openRepository`, so a step's staggered finishes would
 * otherwise depend on how they interleaved (CI saw both of A's runs finish before B's older ones,
 * which left B at its cap while A took the free slots). `slowOrg` makes that org's runs reach the
 * forge last, as a loaded runner can, so the test holds whatever the interleaving.
 */
const steppedForge = (clock: { now(): Date }, diffFor: () => string, slowOrg?: "A" | "B") => {
  const calls: string[] = [];
  const started: Started[] = [];
  // One gate per run, in claim order; `reached` once its diff read is waiting on it.
  let gates: Gate[] = [];
  const newGate = (): Gate => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    const gate = { reached: false, open, opened };
    gates.push(gate);
    return gate;
  };
  const current = new AsyncLocalStorage<Gate>();
  const forge = {
    kind: "github",
    openRepository: async (ref: { installationId: number; repositoryId: number }) => {
      const org = orgByInstallation.get(ref.installationId)!;
      if (org === slowOrg) await new Promise((resolve) => setTimeout(resolve, 50));
      calls.push("openRepository");
      started.push({ org, step: Math.round((clock.now().getTime() - BASE) / STEP_MS) });
      // A run the lane handed out carries its gate; a direct runAnalysis call gets one here.
      const gate = current.getStore() ?? newGate();
      const session: Partial<RepositorySession> = {
        getDiff: async () => {
          calls.push("getDiff");
          gate.reached = true;
          await gate.opened;
          return diffOf(diffFor());
        },
        close: () => {
          calls.push("close");
          return Promise.resolve();
        },
      };
      return session as RepositorySession;
    },
  } as unknown as Forge;
  return {
    forge,
    calls,
    started,
    /** Runs `run` as the next analysis in claim order. */
    claimed: <T>(run: () => Promise<T>): Promise<T> => current.run(newGate(), run),
    pending: () => gates.filter((g) => g.reached).length,
    /** Lets the `n` earliest-claimed waiting reads (default: all) finish. */
    release: (n = Number.POSITIVE_INFINITY) => {
      const now = gates.filter((g) => g.reached).slice(0, n);
      gates = gates.filter((g) => !now.includes(g));
      for (const gate of now) gate.open();
    },
  };
};

const capture = () => {
  const lines: string[] = [];
  return {
    log: createLogger("analysis-lane-e2e", {
      destination: { write: (l: string) => void lines.push(l) },
    }),
    lines,
  };
};

const setup = (options: {
  slots: number;
  orgConcurrency: number;
  diff?: () => string;
  script?: Script;
  slowOrg?: "A" | "B" | undefined;
}) => {
  let step = 0;
  const clock = { now: () => new Date(BASE + step * STEP_MS) };
  const forge = steppedForge(clock, options.diff ?? (() => SMALL_DIFF), options.slowOrg);
  const llm = scriptedRoles(options.script ?? genericScript);
  const { log, lines } = capture();
  const runner: AnalysisRunnerDeps = {
    db: worker,
    forge: forge.forge,
    llm: llm.roles,
    clock,
    log,
    unitKeySalt: "lane-e2e",
    version: "0.0.0",
    usageTargets: usageTargetsFor(llmConfigFromEnv({})),
  };
  const outcomes: AnalysisRun[] = [];
  // Claim order: the lane starts runs in the order the claim handed them out. Forge reads come
  // later and race each other within a step, so they do not show the scheduler's order.
  const handed: Started[] = [];
  const lane = createAnalysisLane(
    {
      db: worker,
      log,
      run: async (claim, signal) => {
        handed.push({ org: claim.orgId === A.orgId ? "A" : "B", step });
        const outcome = await forge.claimed(() => runAnalysis(runner, claim, { signal }));
        outcomes.push(outcome);
        return outcome;
      },
    },
    { slots: options.slots, orgConcurrency: options.orgConcurrency },
  );
  return {
    lane,
    forge,
    llm,
    lines,
    outcomes,
    handed,
    get step() {
      return step;
    },
    advance: () => {
      step++;
    },
  };
};

/** Running analyses per org right now, as the database sees them. */
const runningByOrg = async (): Promise<Record<string, number>> => {
  const { rows } = await superuser.query<{ org_id: string; n: number }>(
    "select org_id, count(*)::int as n from analyses where status = 'running' group by org_id",
  );
  return Object.fromEntries(rows.map((r) => [r.org_id, r.n]));
};

/**
 * One step: claim into the free slots, wait until every started run is reading its diff, check
 * the per-org cap, then let them all finish.
 */
const runStep = async (
  world: ReturnType<typeof setup>,
  lane: AnalysisLane,
  orgConcurrency: number,
  finish = Number.POSITIVE_INFINITY,
): Promise<number> => {
  const started = await lane.tick();
  await vi.waitFor(() => expect(world.forge.pending()).toBe(lane.inFlight), {
    timeout: 10_000,
  });
  for (const n of Object.values(await runningByOrg())) {
    expect(n).toBeLessThanOrEqual(orgConcurrency);
  }
  // Staggered finishes: only the oldest `finish` runs end in this step; the rest go on.
  const ending = Math.min(finish, lane.inFlight);
  const remaining = lane.inFlight - ending;
  world.forge.release(ending);
  await vi.waitFor(() => expect(lane.inFlight).toBe(remaining), { timeout: 10_000 });
  world.advance();
  return started;
};

// --- Criterion 2: fairness under load -------------------------------------------------------------

interface LoadCase {
  readonly slots: number;
  readonly orgConcurrency: number;
  readonly finish: number;
  readonly slowOrg?: "A" | "B";
}

const loadTest = async ({ slots, orgConcurrency, finish, slowOrg }: LoadCase): Promise<void> => {
  // A's 50 are all older than B's 3: a first-come queue would start B only after A's 50.
  await queuePullRequests(A, 50);
  await queuePullRequests(B, 3);
  const world = setup({ slots, orgConcurrency, slowOrg });
  let steps = 0;
  while (steps < 400) {
    const started = await runStep(world, world.lane, orgConcurrency, finish);
    steps++;
    if (started === 0 && world.lane.inFlight === 0) break;
  }
  const startedOf = (org: "A" | "B") => world.handed.filter((s) => s.org === org);
  expect(startedOf("A")).toHaveLength(50);
  expect(startedOf("B")).toHaveLength(3);
  expect(world.outcomes.every((o) => o.outcome === "done")).toBe(true);

  // The bound, in the order analyses were handed out: with two orgs waiting they take turns,
  // so B's i-th analysis (0-based) is among the first 2(i + 1) started, whatever A's backlog
  // and however the slots free up. A first-come queue would start B's first as the 51st.
  const order = world.handed.map((s) => s.org);
  order
    .map((org, at) => ({ org, at }))
    .filter((x) => x.org === "B")
    .forEach((x, i) => {
      expect(x.at, `B's analysis ${i} in ${order.join("")}`).toBeLessThanOrEqual(2 * i + 1);
    });
  if (finish === Infinity && slots >= 2) {
    // In whole steps: B gets min(cap, ⌊slots / 2⌋) slots per step until it is done.
    const perStep = Math.min(orgConcurrency, Math.floor(slots / 2));
    startedOf("B").forEach((s, i) => {
      expect(s.step, `B's analysis ${i}`).toBeLessThanOrEqual(Math.floor(i / perStep));
    });
  }
  // Nor was A starved: once B was done, every analysis handed out was A's, up to its cap
  // at once (the cap itself is checked inside every step).
  const lastOfB = order.lastIndexOf("B");
  expect(order.slice(lastOfB + 1).every((org) => org === "A")).toBe(true);
  if (finish === Infinity && slots >= 2) {
    const stepsOfA = startedOf("A").map((s) => s.step);
    for (let step = 0; step <= Math.max(...stepsOfA); step++) {
      const n = stepsOfA.filter((x) => x === step).length;
      expect(n, `A in step ${step}`).toBeGreaterThan(0);
      expect(n, `A in step ${step}`).toBeLessThanOrEqual(orgConcurrency);
    }
  }
};

describe("load test: one org with 50 pull requests cannot starve another (P4-6)", () => {
  it.each([
    { slots: 4, orgConcurrency: 2, finish: Infinity },
    { slots: 2, orgConcurrency: 2, finish: Infinity },
    { slots: 6, orgConcurrency: 3, finish: Infinity },
    // Review round 1, SF1: one slot (ROCKY_ANALYSIS_CONCURRENCY=1), and runs that finish one
    // at a time, so every claim hands out a single row.
    { slots: 1, orgConcurrency: 2, finish: Infinity },
    { slots: 4, orgConcurrency: 2, finish: 1 },
    { slots: 3, orgConcurrency: 3, finish: 2 },
  ])(
    "slots $slots, org cap $orgConcurrency, $finish finishing per step: B is never starved",
    loadTest,
    120_000,
  );

  // CI flake (2026-10-30): B's runs reached the forge after A's, so the harness ended A's runs
  // first and B sat at its cap. Staggered finishes now follow the claim order whatever the
  // interleaving; here B's runs are made to reach the forge last on purpose.
  it.each([
    { slots: 4, orgConcurrency: 2, finish: 1, slowOrg: "B" as const },
    { slots: 3, orgConcurrency: 3, finish: 2, slowOrg: "B" as const },
  ])(
    "slots $slots, org cap $orgConcurrency, $finish finishing per step, B's forge reads last: B is never starved",
    loadTest,
    120_000,
  );
});

// --- Criterion 1: the per-PR token limit ----------------------------------------------------------

describe("a 200k-token pull request waits for user action (P4-6)", () => {
  it("is held before any model call, runs only after Analyze anyway, and a push re-estimates", async () => {
    const [id] = await queuePullRequests(A, 1);
    let diff = hugeDiff("x");
    const world = setup({ slots: 2, orgConcurrency: 2, diff: () => diff });

    expect(await runStep(world, world.lane, 2)).toBe(1);
    expect(world.outcomes).toEqual([
      { outcome: "awaiting_approval", estimatedTokens: expect.any(Number), tokenLimit: 150_000 },
    ]);
    // No model was called; the forge was only read.
    expect(world.llm.calls).toEqual([]);
    expect(world.forge.calls).toEqual(["openRepository", "getDiff", "close"]);
    const row = async () =>
      (
        await superuser.query<{
          status: string;
          estimated_tokens: number;
          limit_tokens: number;
          document: unknown;
          lease_id: string | null;
        }>(
          "select status, estimated_tokens, limit_tokens, document, lease_id from analyses where id = $1",
          [id],
        )
      ).rows[0]!;
    const held = await row();
    expect(held).toMatchObject({
      status: "awaiting_approval",
      limit_tokens: 150_000,
      document: null,
      lease_id: null,
    });
    expect(held.estimated_tokens).toBeGreaterThanOrEqual(200_000);

    // It waits: further ticks claim nothing.
    expect(await runStep(world, world.lane, 2)).toBe(0);
    expect(world.llm.calls).toEqual([]);

    // The log says what happened in ids and counts; never the title or a path.
    const waitLine = world.lines.find((l) => l.includes("analysis awaiting approval"))!;
    expect(JSON.parse(waitLine)).toMatchObject({
      analysisId: id,
      estimate: held.estimated_tokens,
      tokenLimit: 150_000,
      files: 4,
      sent: 4,
    });
    const logs = world.lines.join("\n");
    expect(logs).not.toContain("title-marker-4417");
    expect(logs).not.toContain("bulk-marker");

    // "Analyze anyway" by a member: audited, and the next claim runs it through the models.
    const approval = await worker.withOrg(A.orgId, (tx) =>
      approveAnalysisOverLimit(tx, id!, { memberId: A.memberId }),
    );
    expect(approval?.estimatedTokens).toBe(held.estimated_tokens);
    expect(await runStep(world, world.lane, 2)).toBe(1);
    expect(world.outcomes.at(-1)).toEqual({ outcome: "done" });
    expect(world.llm.calls.filter((c) => c.role === "triage")).toHaveLength(4);
    expect((await row()).status).toBe("done");
    // Metered (P4-5): every call of the lane's run wrote its usage row; the hold wrote none.
    const usage = await superuser.query<{ n: number }>(
      "select count(distinct call_id)::int as n from llm_usage where analysis_id = $1",
      [id],
    );
    expect(usage.rows[0]!.n).toBe(world.llm.calls.length);

    // The approval was for that revision only: a push is a new row, estimated again, and held
    // again when it is still over the limit (here every file changed, so none is reused).
    diff = hugeDiff("y");
    const pushed = await push(A, id!);
    const callsBefore = world.llm.calls.length;
    expect(await runStep(world, world.lane, 2)).toBe(1);
    expect(world.outcomes.at(-1)).toMatchObject({ outcome: "awaiting_approval" });
    expect(world.llm.calls).toHaveLength(callsBefore);
    const again = await superuser.query<{ status: string; approved_tokens: number | null }>(
      "select status, approved_tokens from analyses where id = $1",
      [pushed],
    );
    expect(again.rows[0]).toEqual({ status: "awaiting_approval", approved_tokens: null });
  }, 120_000);

  it("review round 1, SF2: a 1 MiB CJK pull request is held too (non-ASCII counts by bytes)", async () => {
    const cjk = Array.from({ length: 6 }, (_, f) =>
      addedFile(
        `src/i18n/part${f}.ts`,
        Array.from({ length: 950 }, () => `"${"漢字".repeat(29)}",`),
      ),
    ).join("\n");
    expect(new TextEncoder().encode(cjk).byteLength).toBeGreaterThan(900_000);
    expect(new TextEncoder().encode(cjk).byteLength).toBeLessThan(1024 * 1024);
    await queuePullRequests(B, 1);
    const world = setup({ slots: 1, orgConcurrency: 1, diff: () => cjk });
    await runStep(world, world.lane, 1);
    expect(world.outcomes).toEqual([
      { outcome: "awaiting_approval", estimatedTokens: expect.any(Number), tokenLimit: 150_000 },
    ]);
    expect(world.llm.calls).toEqual([]);
  });

  it("a pull request under the limit is not held", async () => {
    await queuePullRequests(B, 1);
    const world = setup({ slots: 1, orgConcurrency: 1 });
    await runStep(world, world.lane, 1);
    expect(world.outcomes).toEqual([{ outcome: "done" }]);
    expect(world.llm.calls.length).toBeGreaterThan(0);
  });
});

// --- The lease (ADR 0014 R3, merge gate) ----------------------------------------------------------

describe("the lease (ADR 0014 R3)", () => {
  it("a worker that dies mid-run leaves a row the next worker reclaims once the lease expires", async () => {
    const [id] = await queuePullRequests(A, 1);
    const { log } = capture();
    // Worker 1 claims and never finishes (it died: no writes, no renewals).
    const dead = createAnalysisLane(
      { db: worker, log, run: () => new Promise<AnalysisRun>(() => undefined) },
      { slots: 1, orgConcurrency: 1, renewEveryMs: 3_600_000 },
    );
    expect(await dead.tick()).toBe(1);
    // Worker 2 finds nothing while the lease is live...
    const world = setup({ slots: 1, orgConcurrency: 1 });
    expect(await world.lane.tick()).toBe(0);
    // ...and takes the row over once it has expired.
    await superuser.query(
      "update analyses set lease_until = now() - interval '1 second' where id = $1",
      [id],
    );
    expect(await runStep(world, world.lane, 1)).toBe(1);
    expect(world.outcomes).toEqual([{ outcome: "done" }]);
    const { rows } = await superuser.query<{ status: string; attempts: number }>(
      "select status, attempts from analyses where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ status: "done", attempts: 2 });
  });

  it("renews the lease while a run lasts, and aborts the run once the lease is gone", async () => {
    const [id] = await queuePullRequests(B, 1);
    const { log, lines } = capture();
    let signal: AbortSignal | undefined;
    const lane = createAnalysisLane(
      {
        db: worker,
        log,
        run: (claim: ClaimedAnalysis, s) => {
          signal = s;
          return new Promise<AnalysisRun>((resolve) =>
            s.addEventListener("abort", () => resolve({ outcome: "lease_lost" })),
          );
        },
      },
      { slots: 1, orgConcurrency: 1, leaseSeconds: 30, renewEveryMs: 50 },
    );
    expect(await lane.tick()).toBe(1);
    const leaseUntil = async () =>
      (
        await superuser.query<{ until: Date }>(
          "select lease_until as until from analyses where id = $1",
          [id],
        )
      ).rows[0]!.until.getTime();
    const first = await leaseUntil();
    await vi.waitFor(async () => expect(await leaseUntil()).toBeGreaterThan(first), {
      timeout: 5_000,
    });
    expect(signal?.aborted).toBe(false);
    // Another worker now holds the row (as after an expiry and a reclaim).
    await superuser.query("update analyses set lease_id = gen_random_uuid() where id = $1", [id]);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 5_000 });
    await lane.idle();
    expect(lines.some((l) => l.includes("analysis lease lost; run aborted"))).toBe(true);
    await lane.stop();
  });

  const stateOf = async (id: string) =>
    (
      await superuser.query<{ status: string; attempts: number; due: boolean }>(
        "select status, attempts, available_at <= now() as due from analyses where id = $1",
        [id],
      )
    ).rows[0]!;

  it("review round 1, SF5: stopping releases runs in progress without spending an attempt", async () => {
    const [id] = await queuePullRequests(A, 1);
    // Six shutdowns in a row, one more than ANALYSIS_MAX_ATTEMPTS: the row is never failed.
    for (let shutdown = 1; shutdown <= 6; shutdown++) {
      const world = setup({ slots: 1, orgConcurrency: 1 });
      expect(await world.lane.tick()).toBe(1);
      await vi.waitFor(() => expect(world.forge.pending()).toBe(1));
      const stopping = world.lane.stop();
      world.forge.release();
      await stopping;
      expect(world.outcomes).toEqual([{ outcome: "released" }]);
      expect(await stateOf(id!)).toEqual({ status: "queued", attempts: 0, due: true });
      expect(await world.lane.tick()).toBe(0);
    }
    const world = setup({ slots: 1, orgConcurrency: 1 });
    await runStep(world, world.lane, 1);
    expect(world.outcomes).toEqual([{ outcome: "done" }]);
    expect(await stateOf(id!)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("review round 1, SF5: a row claimed while stopping is handed back without spending an attempt", async () => {
    const [id] = await queuePullRequests(B, 1);
    const world = setup({ slots: 1, orgConcurrency: 1 });
    // The claim is in flight when the stop begins.
    const tick = world.lane.tick();
    const stopping = world.lane.stop();
    expect(await tick).toBe(0);
    await stopping;
    expect(world.forge.started).toEqual([]);
    expect(await stateOf(id!)).toEqual({ status: "queued", attempts: 0, due: true });
  });
});
