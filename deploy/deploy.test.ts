/**
 * P10-1 (ADR 0043): the policy the Dockerfile, the compose file, the image workflow and the
 * deploy scripts must keep. The Docker build, the Trivy scan and the smoke test run in CI
 * (`.github/workflows/images.yml`) and locally (`pnpm images:build`, `pnpm security:images`,
 * `pnpm images:smoke`); this file checks, without Docker, that what they run cannot drift from
 * the threat model: pinned digests in one place, no secrets in the build, non-root read-only
 * containers, the role split, loopback ports, least-privilege workflow permissions and a
 * publish job that stays off until the maintainer turns it on.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(new URL(path, `file://${ROOT}`), "utf8");

const DIGEST = /@sha256:[0-9a-f]{64}$/;
const SHA_PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const SECRET_NAME = /(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|KEK)/i;

/** `NAME="image@sha256:..."` entries of scripts/security/images.sh. */
const pinnedImages = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of read("scripts/security/images.sh").split("\n")) {
    const match = /^([A-Z_]+)="([^"]+)"/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
};

const dockerfile = read("deploy/Dockerfile");
const dockerfileLines = dockerfile.split("\n").map((l) => l.trim());
const images = pinnedImages();

interface Service {
  image?: string;
  build?: { context?: string; dockerfile?: string; target?: string };
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  tmpfs?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  env_file?: unknown;
  depends_on?: Record<string, { condition?: string }>;
  volumes?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
  privileged?: boolean;
  pid?: string;
  pids_limit?: number;
  network_mode?: string;
}
interface Compose {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
}
const composeText = read("deploy/docker-compose.yml");
const compose = parse(composeText) as Compose;
const service = (name: string): Service => {
  const found = compose.services[name];
  if (found === undefined) throw new Error(`compose service ${name} is missing`);
  return found;
};
const APP_SERVICES = ["server", "worker", "migrate"] as const;

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      if?: string;
      needs?: string | string[];
      steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
    }
  >;
}
const workflowText = read(".github/workflows/images.yml");
const workflow = parse(workflowText) as Workflow;

describe("deploy/Dockerfile", () => {
  const froms = dockerfileLines
    .filter((l) => /^FROM /i.test(l))
    .map((l) => l.split(/\s+/)[1]!)
    .filter((ref) => ref.includes("/") || ref.includes(":"));

  it("pins every base image by digest, the same digests as scripts/security/images.sh (S2)", () => {
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const ref of froms) expect(ref).toMatch(DIGEST);
    const pinned = new Set(
      [images["NODE_BUILD_IMAGE"], images["DISTROLESS_NODE_IMAGE"]].map((i) => i?.split("@")[1]),
    );
    for (const ref of froms) expect(pinned).toContain(ref.split("@")[1]);
  });

  it("installs from the lockfile only and fetches nothing else (S1)", () => {
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).not.toMatch(/pnpm (add|update|up)\b/);
    expect(dockerfile).not.toMatch(/\b(apt-get|apt|curl|wget|pip)\b/);
    // The package manager itself is pinned to the version package.json declares.
    const { packageManager } = JSON.parse(read("package.json")) as { packageManager: string };
    for (const line of dockerfileLines.filter((l) => /npm (install|i) -g/.test(l))) {
      expect(line).toContain(packageManager);
    }
  });

  it("has no secret-shaped ENV or ARG and copies no dotenv or key file (S3)", () => {
    for (const line of dockerfileLines) {
      if (/^(ENV|ARG) /.test(line)) expect(line).not.toMatch(SECRET_NAME);
      if (/^COPY /.test(line)) expect(line).not.toMatch(/\.env|\.pem|\.key|github-app/);
    }
    expect(dockerfile).not.toMatch(/--mount=type=secret/);
  });

  it("runs every final stage as uid 65532 in production with a healthcheck (S4, S8)", () => {
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const finals = stages.filter((s) => /^[^\n]*\bAS (server|worker|migrate)\b/.test(s));
    expect(finals).toHaveLength(3);
    for (const stage of finals) {
      expect(stage).toMatch(/^USER 65532:65532$/m);
      expect(stage).toMatch(/^ENV NODE_ENV=production$/m);
      expect(stage).toMatch(/^HEALTHCHECK /m);
      expect(stage).not.toMatch(/^RUN /m);
      expect(stage).not.toMatch(/\b(npm|pnpm|tsx|sh|bash)\b/);
    }
  });

  it("keeps secrets and sources out of the build context, at any depth (S3)", () => {
    const ignore = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim());
    // A pattern without `**/` is anchored at the context root: `apps/web/.env.local` would
    // reach `vite build` and its VITE_* values the served app (review round 1).
    for (const entry of [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "!**/.env.example",
      "**/*.env",
      "**/.npmrc",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/id_rsa*",
      "**/github-app.env",
      "node_modules",
      "**/node_modules",
      ".git",
      "artifacts",
    ]) {
      expect(ignore).toContain(entry);
    }
  });

  it("builds the web app with the fixture switch off and checks the build for fixtures (S3)", () => {
    const build = dockerfileLines.find((l) => l.includes("vite build"));
    expect(build).toMatch(/^RUN VITE_ROCKY_FIXTURES= pnpm/);
    expect(dockerfile).toMatch(/node deploy\/check-web-build\.mjs \/out\/web/);
    expect(dockerfile).not.toMatch(/VITE_ROCKY_FIXTURES=on/);
    const markers = read("deploy/check-web-build.mjs");
    const budget = read("apps/web/src/bundle-budget.test.ts");
    for (const marker of markers.match(/^ {2}"([^"]+)",$/gm) ?? []) {
      expect(budget).toContain(marker.trim().replace(/,$/, ""));
    }
  });
});

describe("deploy/docker-compose.yml", () => {
  it("defines the four services and nothing privileged (S4)", () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ["migrate", "postgres", "server", "worker"].sort(),
    );
    for (const [name, svc] of Object.entries(compose.services)) {
      expect(svc.read_only, `${name} read_only`).toBe(true);
      expect(svc.cap_drop, `${name} cap_drop`).toEqual(["ALL"]);
      expect(svc.security_opt, `${name} security_opt`).toContain("no-new-privileges:true");
      expect(svc.privileged ?? false, `${name} privileged`).toBe(false);
      expect(svc.pid, `${name} pid`).toBeUndefined();
      expect(svc.network_mode, `${name} network_mode`).toBeUndefined();
      for (const mount of svc.tmpfs ?? []) {
        expect(mount, `${name} tmpfs ${mount}`).toMatch(/noexec/);
        expect(mount, `${name} tmpfs ${mount}`).toMatch(/nosuid/);
        expect(mount, `${name} tmpfs ${mount}`).toMatch(/nodev/);
      }
      for (const volume of svc.volumes ?? []) {
        expect(volume, `${name} volume ${volume}`).not.toMatch(/docker\.sock|^\/(etc|proc|sys)\b/);
      }
      expect(svc.logging?.options?.["max-size"], `${name} log rotation`).toBeDefined();
      expect(svc.pids_limit, `${name} pids_limit`).toBeGreaterThan(0);
    }
  });

  it("runs the app images as the distroless nonroot user, built from the same Dockerfile (S4)", () => {
    for (const name of APP_SERVICES) {
      const svc = service(name);
      expect(svc.user).toBe("65532:65532");
      expect(svc.image).toBe(`\${ROCKY_IMAGE_PREFIX:-rocky}-${name}:\${ROCKY_IMAGE_TAG:-local}`);
      expect(svc.build).toEqual({ context: "..", dockerfile: "deploy/Dockerfile", target: name });
    }
    expect(service("postgres").user).toBe("postgres");
  });

  it("uses the pinned dev Postgres image (S2)", () => {
    const digest = images["POSTGRES_IMAGE"]?.split("@")[1];
    expect(digest).toBeDefined();
    expect(service("postgres").image?.split("@")[1]).toBe(digest);
  });

  it("publishes the server on the loopback by default and Postgres not at all (S6)", () => {
    expect(service("postgres").ports).toBeUndefined();
    expect(service("worker").ports).toBeUndefined();
    expect(service("migrate").ports).toBeUndefined();
    expect(service("server").ports).toEqual(["${ROCKY_BIND:-127.0.0.1}:${ROCKY_PORT:-4310}:4310"]);
  });

  it("hands each container only its own database login (S5)", () => {
    const migrate = service("migrate").environment ?? {};
    const server = service("server").environment ?? {};
    const worker = service("worker").environment ?? {};
    const postgres = service("postgres").environment ?? {};

    // `${VAR:?message}`: compose refuses to start while a password is missing (nit, round 1).
    const required = (name: string) => `\${${name}:?set in deploy/.env}`;
    expect(migrate["DATABASE_ADMIN_URL"]).toBe(
      `postgres://rocky:${required("ROCKY_DB_MIGRATOR_PASSWORD")}@postgres:5432/rocky`,
    );
    expect(migrate["ROCKY_DB_APP_USER"]).toBe("rocky_app_user");
    expect(migrate["ROCKY_DB_APP_PASSWORD"]).toBe(required("ROCKY_DB_APP_PASSWORD"));
    expect(migrate["ROCKY_DB_WORKER_USER"]).toBe("rocky_worker_user");
    expect(migrate["ROCKY_DB_WORKER_PASSWORD"]).toBe(required("ROCKY_DB_WORKER_PASSWORD"));
    expect(migrate["DATABASE_URL"]).toBeUndefined();
    expect(migrate["WORKER_DATABASE_URL"]).toBeUndefined();

    expect(server["DATABASE_URL"]).toBe(
      `postgres://rocky_app_user:${required("ROCKY_DB_APP_PASSWORD")}@postgres:5432/rocky`,
    );
    expect(server["DATABASE_ADMIN_URL"]).toBeUndefined();
    expect(server["WORKER_DATABASE_URL"]).toBeUndefined();
    expect(server["ROCKY_WEB_DIR"]).toBe("/app/web");

    expect(worker["WORKER_DATABASE_URL"]).toBe(
      `postgres://rocky_worker_user:${required("ROCKY_DB_WORKER_PASSWORD")}@postgres:5432/rocky`,
    );
    expect(worker["DATABASE_URL"]).toBeUndefined();
    expect(worker["DATABASE_ADMIN_URL"]).toBeUndefined();
    expect(worker["ROCKY_HEARTBEAT_FILE"]).toMatch(/^\/tmp\//);
    expect(service("worker").tmpfs?.some((m) => m.startsWith("/tmp:"))).toBe(true);

    expect(postgres["POSTGRES_PASSWORD"]).toBe(required("POSTGRES_PASSWORD"));
    expect(postgres["ROCKY_DB_MIGRATOR_PASSWORD"]).toBe(required("ROCKY_DB_MIGRATOR_PASSWORD"));
    for (const [name, env] of [
      ["migrate", migrate],
      ["server", server],
      ["worker", worker],
    ] as const) {
      expect(env["POSTGRES_PASSWORD"], `${name} sees the superuser password`).toBeUndefined();
      expect(env["ROCKY_DB_MIGRATOR_PASSWORD"], `${name} migrator password`).toBeUndefined();
    }
    expect(server["ROCKY_DB_WORKER_PASSWORD"]).toBeUndefined();
    expect(worker["ROCKY_DB_APP_PASSWORD"]).toBeUndefined();
  });

  it("never writes a literal credential: every password in the file is a required interpolation (S3)", () => {
    const required = /^\$\{[A-Z_]+:\?[^}]+\}$/;
    // To the end of the line: the `:?` message has spaces in it.
    for (const url of composeText.match(/postgres:\/\/[^\n"']+/g) ?? []) {
      expect(url).toMatch(/^postgres:\/\/[a-z_]+:\$\{[A-Z_]+:\?[^}]+\}@postgres:5432\/rocky$/);
    }
    for (const line of composeText.split("\n")) {
      const match = /^\s*([A-Z_]+):\s*(.+)$/.exec(line);
      if (match && SECRET_NAME.test(match[1]!)) expect(match[2]!.trim()).toMatch(required);
    }
  });

  it("reads application secrets from the env file for the server and the worker only (S5)", () => {
    const envFile = ["${ROCKY_ENV_FILE:-./rocky.env}"];
    expect(service("server").env_file).toEqual(envFile);
    expect(service("worker").env_file).toEqual(envFile);
    expect(service("migrate").env_file).toBeUndefined();
    expect(service("postgres").env_file).toBeUndefined();
  });

  it("pins NODE_ENV=production after the env file, so rocky.env cannot switch production off", () => {
    // `environment` wins over `env_file`: an operator's NODE_ENV=development (or an empty one)
    // in rocky.env would otherwise drop the production rules (unverified webhooks, no session
    // secret, http public URLs, the manifest setup route) (should-fix 1, round 1).
    for (const name of ["server", "worker"] as const) {
      expect(service(name).environment?.["NODE_ENV"], name).toBe("production");
    }
  });

  it("starts the apps after the migration step succeeded, and that after Postgres is healthy (S5, S8)", () => {
    expect(service("migrate").depends_on?.["postgres"]?.condition).toBe("service_healthy");
    for (const name of ["server", "worker"] as const) {
      expect(service(name).depends_on?.["migrate"]?.condition).toBe(
        "service_completed_successfully",
      );
    }
  });

  it("documents every compose variable in deploy/.env.example", () => {
    const documented = new Set(
      read("deploy/.env.example")
        .split("\n")
        .map((l) => /^#?\s*([A-Z_]+)=/.exec(l)?.[1])
        .filter((v): v is string => v !== undefined),
    );
    const used = new Set(
      [...composeText.matchAll(/\$\{([A-Z_]+)(?::[-?][^}]*)?\}/g)].map((m) => m[1]!),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(documented, `${name} undocumented`).toContain(name);
  });
});

describe("deploy scripts", () => {
  const init = read("deploy/postgres-init.sh");
  const smoke = read("deploy/smoke.sh");
  const trivy = read("scripts/security/trivy.sh");
  const build = read("deploy/build.sh");

  it("provisioning passes passwords as psql variables, never spliced into SQL, never logged (S5)", () => {
    expect(init).toMatch(/<<-?'SQL'/);
    expect(init).toMatch(/-v migrator_password="\$ROCKY_DB_MIGRATOR_PASSWORD"/);
    expect(init).toContain(":'migrator_password'");
    // The same alphabet as scripts/provision-logins.ts, checked before psql runs.
    expect(init).toMatch(/\*\[!A-Za-z0-9\._~-\]\*\)/);
    const sql = init.slice(init.indexOf("<<'SQL'"));
    expect(sql).not.toMatch(/\$\{?ROCKY_DB_/);
    expect(sql).not.toMatch(/\$\{?POSTGRES_PASSWORD/);
    // The statement carrying the password runs with statement, error and slow-query logging
    // off, so it cannot land in the Postgres log (nit, round 1).
    const passwordStatement = sql.indexOf("ALTER ROLE rocky PASSWORD :'migrator_password'");
    expect(passwordStatement).toBeGreaterThan(0);
    const before = sql.slice(0, passwordStatement);
    expect(before).toMatch(/SET log_statement = 'none';/);
    expect(before).toMatch(/SET log_min_error_statement = 'panic';/);
    expect(before).toMatch(/SET log_min_duration_statement = -1;/);
    expect(sql).not.toMatch(/CREATE ROLE rocky\b[^;]*PASSWORD/);
    for (const revoke of [
      "REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC",
      "REVOKE USAGE ON LANGUAGE sql FROM PUBLIC",
      "REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC",
    ]) {
      expect(sql).toContain(revoke);
    }
    expect(sql).toMatch(/CREATE ROLE rocky\b[^;]*\bLOGIN\b[^;]*\bCREATEROLE\b/);
    expect(sql).not.toMatch(/CREATE ROLE rocky\b[^;]*SUPERUSER/);
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  });

  it("the scan fails on any critical, counts unfixed ones and looks for secrets (S1, S3)", () => {
    expect(trivy).toContain('"$TRIVY_IMAGE"');
    expect(trivy).toMatch(
      /trivy image --input "\/out\/\$target\.tar" --scanners vuln,secret --severity CRITICAL \\\n\s+--exit-code 1/,
    );
    expect(trivy).not.toMatch(/--ignore-unfixed/);
    expect(trivy).not.toMatch(/--skip-/);
    expect(trivy).toMatch(/--format spdx-json/);
    // The bundled npm dependencies are gated through the lockfile, not only listed in an SBOM
    // (should-fix 4, round 1), and the result joins the script's status.
    expect(trivy).toMatch(
      /trivy fs --scanners vuln --severity CRITICAL --exit-code 1 [^\n]*\\\n[^\n]*\/src\/pnpm-lock\.yaml \|\| status=1/,
    );
  });

  it("measures image size the same way on every image store (should-fix 3, round 1)", () => {
    const limit = /SIZE_LIMIT_BYTES=(\d+)/.exec(trivy)?.[1];
    expect(Number(limit)).toBeLessThanOrEqual(250 * 1000 * 1000);
    // `docker image inspect .Size` is compressed under containerd, uncompressed under overlay2.
    const layerSum = /docker history --human=false --format '\{\{\.Size\}\}'/;
    for (const script of [trivy, build, smoke]) {
      expect(script).toMatch(layerSum);
      expect(script).not.toMatch(/docker image inspect --format '\{\{\.Size\}\}'/);
      expect(script).toMatch(/uncompressed/);
    }
  });

  it("the build never pushes and the smoke test never prints a secret (S7, S9)", () => {
    expect(build).not.toMatch(/--push/);
    expect(build).toMatch(/--load/);
    // An echo of a secret-named variable's value (the smoke test writes its generated secrets
    // into files inside a redirected block; that is not a print).
    const secretValue = /\$\{?[A-Z_]*(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY|KEK)/;
    for (const script of [smoke, build, init]) {
      for (const line of script.split("\n")) {
        if (/^\s*(echo|printf)\b/.test(line)) expect(line).not.toMatch(secretValue);
      }
      expect(script).not.toMatch(/\bset -x\b/);
      expect(script).not.toMatch(/\benv\s*$/m);
      expect(script).not.toMatch(/\bprintenv\b/);
    }
  });

  it("the smoke test checks health, the read-only filesystem and the uid at run time (S4, S8)", () => {
    expect(smoke).toMatch(/up -d --wait/);
    expect(smoke).toMatch(/healthz/);
    expect(smoke).toMatch(/EROFS/);
    expect(smoke).toMatch(/65532/);
    expect(smoke).toMatch(/ReadonlyRootfs/);
    expect(smoke).toMatch(/no-new-privileges/);
  });
});

describe(".github/workflows/images.yml", () => {
  const jobs = Object.entries(workflow.jobs);

  it("pins every action to a full commit SHA (S7)", () => {
    const uses = jobs.flatMap(([, job]) => job.steps.map((s) => s.uses)).filter(Boolean);
    expect(uses.length).toBeGreaterThan(3);
    for (const ref of uses) expect(ref).toMatch(SHA_PINNED);
  });

  it("grants least privilege: packages:write and the push only in the gated publish job (S7)", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, job] of jobs) {
      const perms = job.permissions ?? {};
      for (const [scope, level] of Object.entries(perms)) {
        if (name !== "publish") expect(`${scope}:${level}`).not.toBe("packages:write");
        expect(level).not.toBe("write-all");
      }
      const runs = job.steps.map((s) => s.run ?? "").join("\n");
      if (name !== "publish") {
        expect(runs).not.toMatch(/docker push|--push\b/);
        // Keyless blob signing is fine anywhere; signing or attesting an image is a push path.
        expect(runs).not.toMatch(/cosign (sign|attest)(?!-blob)\b/);
      }
      expect(runs).not.toMatch(/\bset -x\b/);
    }
    const publish = workflow.jobs["publish"];
    expect(publish).toBeDefined();
    // Exact: a looser expression (an `||`, a different variable) must be a visible diff here.
    expect(publish?.if).toBe(
      "vars.ROCKY_PUBLISH_IMAGES == 'true' && github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(publish?.permissions).toEqual({
      contents: "read",
      packages: "write",
      "id-token": "write",
    });
    expect([publish?.needs].flat()).toContain("images");
  });

  it("builds, scans, smoke-tests and signs without a registry (S1-S4, S8)", () => {
    const images = workflow.jobs["images"];
    expect(images).toBeDefined();
    expect(images?.permissions).toEqual({ contents: "read", "id-token": "write" });
    const runs = images?.steps.map((s) => s.run ?? "").join("\n") ?? "";
    expect(runs).toContain("deploy/build.sh");
    expect(runs).toContain("scripts/security/trivy.sh");
    expect(runs).toContain("deploy/smoke.sh");
    expect(runs).toMatch(/cosign sign-blob/);
    expect(runs).toMatch(/cosign verify-blob/);
    // The signature is checked against this workflow at the ref that ran, not any workflow of
    // the repository (nit, round 1; security review).
    expect(runs).toMatch(
      /identity="https:\/\/github\.com\/\$REPOSITORY\/\.github\/workflows\/images\.yml@\$REF"/,
    );
    expect(runs).toMatch(/--certificate-identity "\$identity"/);
    expect(runs).not.toMatch(/--certificate-identity-regexp/);
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("pull_request");
    // Neither runs untrusted PR code with the base repository's permissions and secrets.
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.on).not.toHaveProperty("workflow_run");
  });
});

describe("deploy/docker-compose.setup.yml (P10-2, ADR 0044)", () => {
  const overlay = parse(read("deploy/docker-compose.setup.yml")) as Compose;

  it("only opens the wizard on the server and mounts its one credentials directory", () => {
    expect(Object.keys(overlay.services)).toEqual(["server"]);
    const server = overlay.services["server"]!;
    expect(Object.keys(server).sort()).toEqual(["environment", "volumes"]);
    expect(server.environment).toEqual({
      ROCKY_SETUP: "true",
      GITHUB_APP_CREDENTIALS_FILE: "/setup/github-app.env",
    });
    expect(server.volumes).toEqual(["./setup:/setup"]);
  });

  it("keeps the credentials directory out of git and out of the build context", () => {
    expect(read(".gitignore")).toMatch(/^deploy\/setup\/$/m);
    expect(read(".dockerignore")).toMatch(/^deploy\/setup$/m);
  });

  it("does not loosen anything the base file sets (no ports, users, capabilities or env file)", () => {
    const text = read("deploy/docker-compose.setup.yml");
    for (const key of [
      "ports",
      "user",
      "cap_add",
      "privileged",
      "env_file",
      "read_only",
      "NODE_ENV",
    ]) {
      expect(text, key).not.toMatch(new RegExp(`^\\s+${key}:`, "m"));
    }
  });
});

describe("deploy/init-env.sh (P10-2)", () => {
  const script = read("deploy/init-env.sh");

  it("writes private files, never overwrites, and prints no value", () => {
    expect(script).toMatch(/^umask 077$/m);
    expect(script).toMatch(/refusing to overwrite/);
    expect(script).toMatch(/^chmod 600 /m);
    for (const line of script.split("\n").filter((l) => /^\s*echo /.test(l))) {
      expect(line, line).not.toMatch(/\$\(|\$\{?(value|escaped|public_url)\b/);
    }
  });

  it("fills every password compose requires and the production secrets", () => {
    for (const name of [
      "POSTGRES_PASSWORD",
      "ROCKY_DB_MIGRATOR_PASSWORD",
      "ROCKY_DB_APP_PASSWORD",
      "ROCKY_DB_WORKER_PASSWORD",
      "ROCKY_PUBLIC_URL",
      "ROCKY_TRUST_PROXY",
      "ROCKY_SESSION_SECRET",
      "ROCKY_KEK_KEYS",
    ]) {
      expect(script, name).toMatch(new RegExp(`set_value "\\$here/[a-z.]*env" ${name} `));
    }
    for (const name of [...composeText.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]!)) {
      expect(script, name).toContain(` ${name} `);
    }
  });
});

describe("configuration reference", () => {
  it("documents the new variables in .env.example", () => {
    const example = read(".env.example");
    for (const name of [
      "ROCKY_HEARTBEAT_FILE",
      "ROCKY_DB_APP_USER",
      "ROCKY_DB_APP_PASSWORD",
      "ROCKY_DB_WORKER_USER",
      "ROCKY_DB_WORKER_PASSWORD",
    ]) {
      expect(example).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
    }
  });
});
