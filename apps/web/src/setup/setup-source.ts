/**
 * The setup wizard's port (P10-2, ADR 0044) and its server source. `load` hands over unchecked
 * JSON: the page validates it with `parseSetupStatus` (the one place, so no source can skip
 * it). The two POSTs carry the setup session's CSRF token from the last status.
 */
import {
  SetupProbeResponse,
  SetupStatusResponse,
  type SetupProbeResult,
} from "@rocky-reviews/core";
import { CSRF_HEADER } from "../session.js";

export const STATUS_PATH = "/api/setup/status";
export const LLM_TEST_PATH = "/api/setup/llm-test";
export const FINISH_PATH = "/api/setup/finish";

export type LlmTestResult =
  | { readonly kind: "done"; readonly results: readonly SetupProbeResult[] }
  | { readonly kind: "busy" | "too_soon" | "invalid_config" | "error" };

export interface SetupSource {
  load(options?: { signal?: AbortSignal }): Promise<unknown>;
  testLlm(csrfToken: string): Promise<LlmTestResult>;
  finish(csrfToken: string): Promise<boolean>;
}

export class SetupLoadError extends Error {
  override readonly name = "SetupLoadError";
  constructor(readonly reason: "no_session" | "closed" | "failed") {
    super(`setup: ${reason}`);
  }
}

/** Validates what a source loaded; anything else is a failure, without echoing it. */
export const parseSetupStatus = (raw: unknown): SetupStatusResponse => {
  const parsed = SetupStatusResponse.safeParse(raw);
  if (!parsed.success) throw new SetupLoadError("failed");
  return parsed.data;
};

const post = (path: string, csrfToken: string) =>
  fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", [CSRF_HEADER]: csrfToken },
  });

export const createHttpSetupSource = (): SetupSource => ({
  load: async (options) => {
    const response = await fetch(STATUS_PATH, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (response.status === 403) throw new SetupLoadError("no_session");
    // Setup was finished (or the server runs without ROCKY_SETUP).
    if (response.status === 404) throw new SetupLoadError("closed");
    if (!response.ok) throw new SetupLoadError("failed");
    return response.json() as Promise<unknown>;
  },
  testLlm: async (csrfToken) => {
    try {
      const response = await post(LLM_TEST_PATH, csrfToken);
      if (response.status === 409) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        return { kind: body.error === "invalid_config" ? "invalid_config" : "busy" };
      }
      if (response.status === 429) return { kind: "too_soon" };
      if (!response.ok) return { kind: "error" };
      const parsed = SetupProbeResponse.safeParse(await response.json());
      return parsed.success ? { kind: "done", results: parsed.data.results } : { kind: "error" };
    } catch {
      return { kind: "error" };
    }
  },
  finish: async (csrfToken) => {
    try {
      return (await post(FINISH_PATH, csrfToken)).ok;
    } catch {
      return false;
    }
  },
});
