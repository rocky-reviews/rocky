// Run in the builder stage after `vite build` (deploy/Dockerfile): the web app that ships in
// the server image must be a production build with no fixture branch in it. Vite folds the
// fixture switch (`import.meta.env.DEV || VITE_ROCKY_FIXTURES === "on"`, apps/web/src/main.tsx)
// to false in a production build with the variable unset; the build then carries none of the
// fixture text. This checks the same markers as apps/web/src/bundle-budget.test.ts in the
// built assets, so a stray `.env.production` or VITE_ROCKY_FIXTURES=on in the build
// environment fails the image build instead of shipping a fixture-mode app.
//
//   node deploy/check-web-build.mjs <web-build-dir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (dir === undefined || dir === "") {
  console.error("usage: node deploy/check-web-build.mjs <web-build-dir>");
  process.exit(2);
}

/** Text that exists only in the fixtures (kept in step with bundle-budget.test.ts). */
const FIXTURE_MARKERS = [
  "Team invitations with expiring links",
  "An admin creates an invite",
  "Retry failed webhook deliveries with backoff",
  "ledger-rules",
  "feat/team-invites",
  "Swallowed error in the nightly billing retry loop",
];

const files = [];
const walk = (current) => {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && /\.(js|mjs|css|html)$/.test(entry.name)) files.push(path);
  }
};
walk(dir);
if (!files.some((f) => f.endsWith("index.html")) || !files.some((f) => f.endsWith(".js"))) {
  console.error("check-web-build: no index.html or no JavaScript in the build");
  process.exit(1);
}

const found = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const marker of FIXTURE_MARKERS) {
    if (text.includes(marker)) found.push(`${file.slice(dir.length + 1)}: ${marker}`);
  }
}
if (found.length > 0) {
  console.error(
    `check-web-build: fixture content in the production build:\n  ${found.join("\n  ")}`,
  );
  process.exit(1);
}
const total = files.reduce((sum, f) => sum + statSync(f).size, 0);
console.log(`check-web-build: ${files.length} files, ${(total / 1e6).toFixed(1)} MB, no fixtures`);
