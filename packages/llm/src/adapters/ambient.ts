import { LlmCallError } from "@rocky-reviews/core";
import { LlmConfigError } from "../config.js";
import type { ProviderKind } from "../providers.js";

/**
 * Environment switches that would undo the adapters' hardening (P4-2 review round 1, N1/N2;
 * ADR 0013 T1, T3). Rocky cannot neutralise them inside the SDKs, so it refuses to run with them:
 * at boot (the adapter factory) and again at every call, before anything is sent or imported.
 *
 * - `ANTHROPIC_CUSTOM_HEADERS`: merged into every Claude client's headers, after Rocky's own, so
 *   it can replace `x-api-key` or `Authorization`, and it goes to Bedrock, Vertex and Foundry too.
 * - `GOOGLE_SDK_NODE_LOGGING`: turns on google-auth-library / gaxios debug logging, which prints
 *   token-endpoint traffic, access tokens included.
 */

type Env = Readonly<Record<string, string | undefined>>;

const CLAUDE_KINDS: readonly ProviderKind[] = ["anthropic", "bedrock", "vertex", "foundry"];

const REFUSED: readonly { readonly name: string; readonly kinds: readonly ProviderKind[] }[] = [
  { name: "ANTHROPIC_CUSTOM_HEADERS", kinds: CLAUDE_KINDS },
  { name: "GOOGLE_SDK_NODE_LOGGING", kinds: ["vertex"] },
];

/** The refused variables that are set (non-empty) for this provider kind. */
export const refusedAmbient = (kind: ProviderKind, env: Env = process.env): string[] =>
  REFUSED.filter(({ name, kinds }) => kinds.includes(kind) && (env[name] ?? "") !== "").map(
    ({ name }) => name,
  );

/** Boot: a set variable is a config error that names it (never its value). */
export const assertAmbientAtBoot = (kind: ProviderKind): void => {
  const names = refusedAmbient(kind);
  if (names.length > 0) {
    throw new LlmConfigError(
      names.map((name) => ({ path: name, message: `must be unset for the ${kind} provider` })),
    );
  }
};

/** Per call: the variable appeared after boot; fail before anything is sent. */
export const assertAmbientAtCall = (kind: ProviderKind): void => {
  if (refusedAmbient(kind).length > 0) throw new LlmCallError("invalid_request");
};
