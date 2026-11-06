import {
  FullSha,
  limits,
  RepoName,
  RepoOwner,
  RepositoryPath,
  Severity,
  textProblem,
} from "@rocky-reviews/schema";
import { z } from "zod";
import { DISMISS_REASONS, isDismissReason, type DismissReason } from "./drafts.js";
import {
  isMemoryKind,
  MAX_MEMORY_TEXT_INPUT_LENGTH,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  type MemoryKind,
} from "./memory.js";

/**
 * The memory page's wire format (P8-3, ADR 0039): the server's answer for one repository's
 * entries, validated by the web app before anything is shown, and the edit request the server
 * reads. Entry text is untrusted (it comes from pull requests): the page renders it as text.
 */

const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a uuid");
const Login = z.string().regex(/^[A-Za-z0-9-]{1,39}$/, "must be a login");
const Timestamp = z.iso.datetime({ offset: true });

export const MemoryEntryView = z.strictObject({
  id: Uuid,
  kind: z.enum(MEMORY_KINDS),
  origin: z.enum(MEMORY_ORIGINS),
  text: z
    .string()
    .min(1)
    .max(limits.MAX_MEMORY_TEXT_LENGTH)
    .refine((t) => textProblem(t, "line") === undefined, "must be one line of text"),
  reason: z.enum(DISMISS_REASONS).nullable(),
  /** A dismissal's covered severity; `null` covers up to medium. */
  severity: Severity.nullable(),
  evidence: z.strictObject({
    path: RepositoryPath,
    sha: FullSha,
    range: z
      .strictObject({
        start: z.int().min(1).max(limits.MAX_LINE_NUMBER),
        end: z.int().min(1).max(limits.MAX_LINE_NUMBER),
      })
      .refine((r) => r.end >= r.start && r.end - r.start < limits.MAX_RANGE_LINES, "bad range"),
    pullRequestNumber: z.int().min(1).max(limits.MAX_PR_NUMBER),
  }),
  confidence: z.int().min(limits.MIN_CONFIDENCE).max(limits.MAX_CONFIDENCE),
  /** Who taught it: a member's login while they are one; "former member" otherwise. */
  author: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("member"), login: Login }),
    z.strictObject({ kind: z.literal("former_member") }),
  ]),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  supersededBy: Uuid.nullable(),
  disabledAt: Timestamp.nullable(),
});
export type MemoryEntryView = z.infer<typeof MemoryEntryView>;

/** Most entries the page lists (the store's `MAX_MEMORY_LISTING`). */
export const MAX_MEMORY_PAGE_ENTRIES = 500;

export const MemoryListResponse = z.strictObject({
  repository: z.strictObject({
    owner: RepoOwner,
    name: RepoName,
    /** Whether reviews of the repository use memory (and learn into it). */
    memoryEnabled: z.boolean(),
  }),
  /** Whether the caller may edit, delete and switch entries (`memory.edit`). */
  canEdit: z.boolean(),
  entries: z
    .array(MemoryEntryView)
    .max(MAX_MEMORY_PAGE_ENTRIES)
    .refine((e) => new Set(e.map((x) => x.id)).size === e.length, "duplicate ids"),
  /** More entries exist than the page lists (the newest are listed). */
  truncated: z.boolean(),
});
export type MemoryListResponse = z.infer<typeof MemoryListResponse>;

/** What an edit may change: the kind, the text and (for a dismissal) the reason. */
export interface MemoryEdit {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly reason: DismissReason | null;
}

/**
 * An edit request body (`{ kind, text, reason? }`), or `null`. The text is only bounded here; the
 * store scrubs and checks it like every entry (`createMemoryEntry`).
 */
export const parseMemoryEdit = (body: unknown): MemoryEdit | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "kind" && k !== "text" && k !== "reason")) return null;
  const { kind, text, reason = null } = body as Record<string, unknown>;
  if (!isMemoryKind(kind)) return null;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_MEMORY_TEXT_INPUT_LENGTH)
    return null;
  if (kind === "dismissal" ? !isDismissReason(reason) : reason !== null) return null;
  return { kind, text, reason: kind === "dismissal" && isDismissReason(reason) ? reason : null };
};

/** A switch request body (`{ <field>: boolean }`), or `null`. */
export const parseMemorySwitch = (body: unknown, field: "disabled" | "enabled"): boolean | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== field) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : null;
};
