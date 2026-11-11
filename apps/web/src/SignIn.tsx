/**
 * What a signed-out page offers (P10-4). With the GitHub App: "Sign in with GitHub". In token
 * mode there is no GitHub login: the server prints a one-time sign-in link in its log at boot,
 * and the page says where to find it. The method comes from `GET /api/session`'s 401 answer;
 * until it is known (and on any doubt) the page offers GitHub's login, as before.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fetchSignInMethod, signInHref, type SignInMethod } from "./session.js";

export const TOKEN_LINK_COMMAND = "docker compose logs server | grep /auth/token/start";

export const TokenLinkHint = () => (
  <>
    Open the one-time sign-in link printed in the server&rsquo;s log (
    <code>{TOKEN_LINK_COMMAND}</code>). Each link works once; restart the server for a new one.
  </>
);

/** `rest` follows the GitHub link ("to see your inbox."); the token hint stands on its own. */
export const SignInText = ({ method, returnTo, rest }: SignInTextProps) =>
  method === "token_link" ? (
    <TokenLinkHint />
  ) : (
    <>
      <a href={signInHref(returnTo)}>Sign in with GitHub</a> {rest}
    </>
  );

type SignInTextProps = {
  method: SignInMethod;
  returnTo?: string | undefined;
  rest: ReactNode;
};

/** Asks the server how to sign in once, then renders `SignInText`. */
export const SignIn = ({ returnTo, rest }: Omit<SignInTextProps, "method">) => {
  const [method, setMethod] = useState<SignInMethod>("github");
  useEffect(() => {
    const abort = new AbortController();
    void fetchSignInMethod({ signal: abort.signal }).then(
      (m) => !abort.signal.aborted && setMethod(m),
    );
    return () => abort.abort();
  }, []);
  return <SignInText method={method} returnTo={returnTo} rest={rest} />;
};
