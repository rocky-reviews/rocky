import { fileURLToPath } from "node:url";
import { checkRepository } from "./docs/links.js";

/**
 * `pnpm docs:check` (P10-3): the docs build. Every relative Markdown link and anchor in the
 * repository must resolve. Runs in `pnpm verify`, so CI checks it on every pull request.
 */
const { files, problems } = checkRepository(fileURLToPath(new URL("..", import.meta.url)));
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`docs: ${problems.length} broken link(s) in ${files} Markdown files`);
  process.exit(1);
}
console.log(`docs: ${files} Markdown files, every relative link and anchor resolves`);
