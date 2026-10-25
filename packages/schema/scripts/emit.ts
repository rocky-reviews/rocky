// `pnpm schema:emit`: writes the JSON Schema for the analysis document. Deterministic, so a
// repeated run leaves the file byte-identical; the snapshot test fails when the Zod schemas
// change without a re-emit.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitJsonSchema } from "../src/json-schema.js";

const dir = fileURLToPath(new URL("../json-schema/", import.meta.url));
mkdirSync(dir, { recursive: true });
const target = `${dir}analysis-document.schema.json`;
writeFileSync(target, emitJsonSchema(), "utf8");
console.log(`wrote ${target}`);
