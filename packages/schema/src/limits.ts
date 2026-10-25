/**
 * Every size limit of the analysis document, in one place.
 *
 * The limits are part of the contract: a model (or an attacker steering one through PR
 * content) cannot pad its way past them, and every consumer can size buffers, columns and
 * UI from these numbers. Raising one is a schema change and is reviewed as such.
 *
 * Rationale per group:
 * - identifiers and paths: long enough for anything real, short enough to embed in SVG ids,
 *   URL fragments and comment anchors.
 * - labels and one-liners: rendered on one line in the UI; longer text wraps into noise.
 * - prose: bodies are markdown; 4 000 characters is roughly a screen of text, which is the
 *   most a reviewer reads before scrolling to the code.
 * - collections: a PR with more files than MAX_FILES is split or flagged by the pipeline
 *   before analysis (P4-6); graph caps follow PR Lens, whose renderer they were tuned for.
 */

// --- Identifiers, paths, hashes ------------------------------------------------------------

/** Ids are model-authored, so they are shaped to survive SVG ids and URL fragments. */
export const MAX_ID_LENGTH = 128;
/** Linux allows 4 096; GitHub rejects paths above 4 096 too, but nothing real approaches 1 024. */
export const MAX_PATH_LENGTH = 1024;
/** GitHub logins are at most 39 characters. */
export const MAX_REPO_OWNER_LENGTH = 39;
/** GitHub repository names are at most 100 characters. */
export const MAX_REPO_NAME_LENGTH = 100;
/** Git ref names are limited by the filesystem; 255 is the usual component cap. */
export const MAX_REF_LENGTH = 255;
export const MAX_PR_NUMBER = 1_000_000_000;

// --- Single-line text ------------------------------------------------------------------------

/** Lane, node, edge and flow labels; walkthrough headings; view titles. */
export const MAX_LABEL_LENGTH = 120;
/** A finding's title, shown as a heading in the inbox and on the diff. */
export const MAX_TITLE_LENGTH = 200;
/** Triage reason, "what changed", "why this level", verdict reason: one or two sentences. */
export const MAX_REASON_LENGTH = 500;
/** One "checked, looks fine" item. */
export const MAX_CHECKED_ITEM_LENGTH = 300;
/** A memory entry as it is quoted in the document. */
export const MAX_MEMORY_TEXT_LENGTH = 300;
/** Where a memory entry came from, e.g. "decision · PR #612". */
export const MAX_MEMORY_SOURCE_LENGTH = 120;
/** Generator and model names. */
export const MAX_GENERATOR_NAME_LENGTH = 64;
export const MAX_MODEL_NAME_LENGTH = 128;
export const MAX_VERSION_LENGTH = 32;
/** A flow message's "repeat" count: batched requests, retries. */
export const MAX_MESSAGE_REPEAT = 1_000_000;

// --- Multi-line text -------------------------------------------------------------------------

/** Node, edge, lane, flow and view summaries. */
export const MAX_SUMMARY_LENGTH = 2000;
/** Finding body (markdown subset). */
export const MAX_BODY_LENGTH = 4000;
/** A flag's text under a hunk line. */
export const MAX_FLAG_TEXT_LENGTH = 1000;
/** The prompt handed to a coding agent for "send to agent". */
export const MAX_AGENT_PROMPT_LENGTH = 2000;
/** The briefing summary paragraph. */
export const MAX_BRIEFING_SUMMARY_LENGTH = 2000;
/** One replacement line in a suggestion (code lines, so generous). */
export const MAX_SUGGESTION_LINE_LENGTH = 500;
/** The context line a suggestion anchors to. */
export const MAX_CONTEXT_LINE_LENGTH = MAX_SUGGESTION_LINE_LENGTH;
/** A payload type signature, as text. */
export const MAX_PAYLOAD_SHAPE_BYTES = 2048;
/** A payload sample, serialised. */
export const MAX_PAYLOAD_SAMPLE_BYTES = 4096;
export const MAX_PAYLOAD_SAMPLE_DEPTH = 8;

// --- Lines and ranges ------------------------------------------------------------------------

/** Line numbers and hunk sizes; nothing reviewable has ten million lines. */
export const MAX_LINE_NUMBER = 10_000_000;
/** A finding or flag covers at most this many lines; beyond that it is a file-level remark. */
export const MAX_RANGE_LINES = 200;
/** Replacement lines a suggestion may carry. */
export const MAX_SUGGESTION_LINES = 100;
/** Hunks a single file may have in the diff. */
export const MAX_HUNKS_PER_FILE = 500;
/** Additions or deletions recorded for one file. */
export const MAX_FILE_LINE_COUNT = MAX_LINE_NUMBER;

// --- Scores ----------------------------------------------------------------------------------

export const MIN_SCORE = 0;
export const MAX_SCORE = 100;
export const MIN_CONFIDENCE = 0;
export const MAX_CONFIDENCE = 100;
/** Estimated review time, in minutes. A day of review is the most a single PR gets. */
export const MIN_REVIEW_MINUTES = 1;
export const MAX_REVIEW_MINUTES = 480;

/**
 * Triage score bands per level. A score outside its level's band is rejected by the
 * integrity checks (SCORE_LEVEL_MISMATCH): the sidebar sorts by level and shows the score,
 * so the two must agree. Bands are inclusive and contiguous.
 */
export const SCORE_BANDS = {
  critical: { min: 80, max: 100 },
  important: { min: 50, max: 79 },
  normal: { min: 20, max: 49 },
  low: { min: 0, max: 19 },
} as const;

// --- Collections -----------------------------------------------------------------------------

/** Files in the PR's file list (and therefore in triage). */
export const MAX_FILES = 1000;
export const MAX_FINDINGS = 200;
export const MAX_FLAGS_PER_FILE = 50;
export const MAX_MEMORY_REFS_PER_FINDING = 8;
export const MAX_MEMORY_APPLIED = 50;
export const MAX_CHECKED_ITEMS = 30;
export const MAX_REVIEW_PATH = 50;
export const MAX_GENERATOR_ROLES = 8;

export const MIN_LANES = 1;
export const MAX_LANES = 16;
export const MIN_NODES = 1;
export const MAX_NODES = 256;
export const MAX_EDGES = 512;
export const MAX_FLOWS = 16;
export const MIN_FLOW_PARTICIPANTS = 2;
export const MAX_FLOW_PARTICIPANTS = 12;
export const MIN_FLOW_MESSAGES = 1;
export const MAX_FLOW_MESSAGES = 64;
export const MAX_FILES_PER_NODE = 64;
export const MAX_FILES_PER_EDGE = 32;
export const MAX_BADGES_PER_NODE = 6;
/** Children per view, total views in the tree, and how deep the tree may nest. */
export const MAX_VIEW_CHILDREN = 32;
export const MAX_VIEWS_TOTAL = 64;
export const MAX_VIEW_DEPTH = 4;
/** Ids a view scope or step focus may name per collection. */
export const MAX_SCOPE_LANES = MAX_LANES;
export const MAX_SCOPE_NODES = MAX_NODES;
export const MAX_SCOPE_EDGES = MAX_EDGES;
export const MAX_SCOPE_FLOWS = MAX_FLOWS;
export const MAX_SCOPE_MESSAGES = MAX_FLOW_MESSAGES;
/** Two steps is the floor because one step is a caption; twelve because a rail loses the reader. */
export const MIN_WALKTHROUGH_STEPS = 2;
export const MAX_WALKTHROUGH_STEPS = 12;
export const MAX_LANE_ORDER = 64;
