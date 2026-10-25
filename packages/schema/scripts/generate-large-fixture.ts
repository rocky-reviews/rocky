// Writes fixtures/large-60-files.json from the deterministic builder, in canonical (parsed)
// form so the committed file equals what parseAnalysisDocument returns for it.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildLargeFixture } from "../src/fixtures/large-60-files.js";
import { formatIssues } from "../src/errors.js";
import { parseAnalysisDocument } from "../src/parse.js";

const parsed = parseAnalysisDocument(buildLargeFixture());
if (!parsed.ok) {
  console.error(`large fixture is invalid:\n${formatIssues(parsed.error.issues)}`);
  process.exit(1);
}

const target = fileURLToPath(new URL("../fixtures/large-60-files.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(parsed.value, null, 2)}\n`, "utf8");
console.log(`wrote ${target}`);
