/**
 * P6-9: who a pending comment is from, as GitHub will show it (POC "@you · Pending"): the
 * reviewer's login from the session, "you" until the session has loaded. The login is text in
 * a <bdi>, never markup.
 */
import { createContext, useContext } from "react";

/** The signed-in reviewer's GitHub login, or null until the session is read. */
export const LoginContext = createContext<string | null>(null);

/** An empty login counts as none (the session has not said who it is). */
const known = (login: string | null): login is string => login !== null && login !== "";

export const authorName = (login: string | null): string => (known(login) ? `@${login}` : "you");

/** Two letters for the avatar ("DA" for dana-k); "Y" for "you". */
export const authorInitials = (login: string | null): string =>
  known(login)
    ? login
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 2)
        .toUpperCase() || "Y"
    : "Y";

export const Author = () => {
  const login = useContext(LoginContext);
  return (
    <>
      <span className="avatar" aria-hidden="true">
        {authorInitials(login)}
      </span>
      <b>
        <bdi>{authorName(login)}</bdi>
      </b>
    </>
  );
};
