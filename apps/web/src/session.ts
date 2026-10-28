/**
 * The session API for the web app (P7-1, ADR 0020). The shell calls these; it never reads
 * cookies (they are HttpOnly) and never builds a redirect target itself beyond a same-origin
 * path, which the server validates again.
 *
 * Same origin only: in development, the Vite dev server must proxy `/auth` and `/api` to the
 * server, and `ROCKY_PUBLIC_URL` must be the origin the browser shows.
 */

export interface SessionOrg {
  readonly id: string;
  /** The GitHub account login of the org (display only). */
  readonly login: string;
  readonly memberId: string;
  /** The user's own GitHub login in that org (display only). */
  readonly memberLogin: string;
  readonly role: "owner" | "admin" | "member";
}

export interface Session {
  readonly authenticated: true;
  readonly user: { readonly id: string; readonly forgeUserId: number };
  readonly orgs: readonly SessionOrg[];
  /** `null` when the user belongs to several orgs and has not chosen one yet. */
  readonly activeOrgId: string | null;
  /** Send as `x-rocky-csrf` on every state-changing request. Kept in memory only. */
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
}

export const CSRF_HEADER = "x-rocky-csrf";

/** Where "Sign in with GitHub" links to; `returnTo` is the path to come back to. */
export const signInHref = (returnTo?: string): string =>
  returnTo === undefined || !returnTo.startsWith("/") || returnTo.startsWith("//")
    ? "/auth/github/login"
    : `/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`;

/** The current session, or `null` when signed out (401). Other failures throw. */
export const fetchSession = async (): Promise<Session | null> => {
  const response = await fetch("/api/session", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`session: ${response.status}`);
  return (await response.json()) as Session;
};

/** Ends the session on the server (POST with the CSRF token). */
export const signOut = async (session: Session): Promise<void> => {
  const response = await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: session.csrfToken },
  });
  if (response.status !== 204) throw new Error(`logout: ${response.status}`);
};

/** Chooses the org to work in; returns the updated session. */
export const chooseOrg = async (session: Session, orgId: string): Promise<Session> => {
  const response = await fetch("/api/session/active-org", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", [CSRF_HEADER]: session.csrfToken },
    body: JSON.stringify({ orgId }),
  });
  if (!response.ok) throw new Error(`active org: ${response.status}`);
  return (await response.json()) as Session;
};
