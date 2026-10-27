/** The seeded PRs the eval suite runs (P4-7), in report order. */
import { PR1003 } from "./pr-1003.js";
import { PR1104 } from "./pr-1104.js";
import { PR1205 } from "./pr-1205.js";
import { PR847_SEEDED, PR912_SEEDED } from "./pr-847-912.js";
import type { SeededPr } from "./types.js";

export const SEEDED_PRS: readonly SeededPr[] = [PR847_SEEDED, PR912_SEEDED, PR1003, PR1104, PR1205];

export type { SeededPr } from "./types.js";
