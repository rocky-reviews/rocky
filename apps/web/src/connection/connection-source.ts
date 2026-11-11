/**
 * The token connection's port (P10-4, ADR 0045) and its server source. Every answer is validated
 * against the core schemas before the page sees it; a refusal is its fixed code (and, for a rate
 * limit, when to try again). Requests that change something carry the session's CSRF token. The
 * token goes out once, in the body of the save request, and is never kept.
 */
import {
  AddRepositoryResponse,
  AvailableRepositoriesResponse,
  ConnectionErrorResponse,
  ConnectionResponse,
  SaveTokenResponse,
  SyncResponse,
} from "@rocky-reviews/core";
import type { z } from "zod";
import { CSRF_HEADER, fetchSession } from "../session.js";

export type Refused = {
  readonly kind: "refused";
  readonly error: string;
  readonly retryAt: string | null;
};

/** An answer: the value, a refusal by code, or no usable answer at all. */
export type Answer<T> =
  { readonly kind: "ok"; readonly value: T } | Refused | { readonly kind: "error" };

export interface ConnectionSource {
  /** Throws `ConnectionLoadError` when there is nothing to show. */
  load(options?: { signal?: AbortSignal }): Promise<ConnectionResponse>;
  saveToken(token: string): Promise<Answer<SaveTokenResponse>>;
  removeToken(): Promise<Answer<null>>;
  available(): Promise<Answer<AvailableRepositoriesResponse>>;
  addRepository(forgeRepoId: number): Promise<Answer<AddRepositoryResponse>>;
  removeRepository(id: string): Promise<Answer<null>>;
  sync(repoId?: string): Promise<Answer<SyncResponse>>;
}

export class ConnectionLoadError extends Error {
  override readonly name = "ConnectionLoadError";
  /** `app_mode`: the server is connected with the GitHub App (the routes are not there). */
  constructor(readonly reason: "signed_out" | "app_mode" | "failed") {
    super(`connection: ${reason}`);
  }
}

export const CONNECTION_PATH = "/api/connection";
export const TOKEN_PATH = "/api/connection/token";
export const AVAILABLE_PATH = "/api/connection/available";
export const REPOSITORIES_PATH = "/api/connection/repositories";
export const SYNC_PATH = "/api/connection/sync";

/** Reads a refusal body; anything that is not one is `error`. */
export const refusalOf = async (response: Response): Promise<Refused | { kind: "error" }> => {
  const parsed = ConnectionErrorResponse.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { kind: "refused", error: parsed.data.error, retryAt: parsed.data.retryAt }
    : { kind: "error" };
};

const answer = async <T>(response: Response, schema: z.ZodType<T>): Promise<Answer<T>> => {
  if (!response.ok) return refusalOf(response);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "error" };
};

const empty = async (response: Response): Promise<Answer<null>> =>
  response.status === 204 ? { kind: "ok", value: null } : refusalOf(response);

export const createHttpConnectionSource = (): ConnectionSource => {
  let token: Promise<string | null> | undefined;
  const csrf = () => {
    token ??= fetchSession().then(
      (session) => session?.csrfToken ?? null,
      () => null,
    );
    return token;
  };
  const send = async (
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Response | null> => {
    const csrfToken = await csrf();
    if (csrfToken === null) {
      token = undefined;
      return null;
    }
    return fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        [CSRF_HEADER]: csrfToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const run = async <T>(work: () => Promise<Answer<T>>): Promise<Answer<T>> => {
    try {
      return await work();
    } catch {
      return { kind: "error" };
    }
  };
  return {
    load: async (options) => {
      const response = await fetch(CONNECTION_PATH, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (response.status === 401) throw new ConnectionLoadError("signed_out");
      if (response.status === 404) throw new ConnectionLoadError("app_mode");
      if (!response.ok) throw new ConnectionLoadError("failed");
      const parsed = ConnectionResponse.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ConnectionLoadError("failed");
      return parsed.data;
    },
    saveToken: (value) =>
      run(async () => {
        const response = await send("PUT", TOKEN_PATH, { token: value });
        return response === null ? { kind: "error" } : answer(response, SaveTokenResponse);
      }),
    removeToken: () =>
      run(async () => {
        const response = await send("DELETE", TOKEN_PATH);
        return response === null ? { kind: "error" } : empty(response);
      }),
    available: () =>
      run(async () => {
        const response = await fetch(AVAILABLE_PATH, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        return answer(response, AvailableRepositoriesResponse);
      }),
    addRepository: (forgeRepoId) =>
      run(async () => {
        const response = await send("POST", REPOSITORIES_PATH, { forgeRepoId });
        return response === null ? { kind: "error" } : answer(response, AddRepositoryResponse);
      }),
    removeRepository: (id) =>
      run(async () => {
        if (!/^[0-9a-f-]{36}$/.test(id)) return { kind: "error" };
        const response = await send("DELETE", `${REPOSITORIES_PATH}/${id}`);
        return response === null ? { kind: "error" } : empty(response);
      }),
    sync: (repoId) =>
      run(async () => {
        const response = await send("POST", SYNC_PATH, repoId === undefined ? {} : { repoId });
        return response === null ? { kind: "error" } : answer(response, SyncResponse);
      }),
  };
};
