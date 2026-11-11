/**
 * A saved token, described without its value (P10-4): owner, kind, expiry, when it was saved,
 * and its warnings as pills with a note each. Used by the setup wizard and the connection page.
 */
import type { ConnectionToken } from "@rocky-reviews/core";
import { timeAgo } from "../lib/time.js";
import {
  localDate,
  TOKEN_KIND_LABEL,
  TOKEN_WARNING_LABEL,
  TOKEN_WARNING_TEXT,
} from "./connection-model.js";

export const TokenSummary = ({ token, now }: { token: ConnectionToken; now: number }) => (
  <>
    <dl className="token-facts">
      <div>
        <dt>GitHub user</dt>
        <dd>
          <bdi>@{token.login}</bdi>
        </dd>
      </div>
      <div>
        <dt>Kind</dt>
        <dd>{TOKEN_KIND_LABEL[token.kind]}</dd>
      </div>
      <div>
        <dt>Expires</dt>
        <dd>{token.expiresAt === null ? "Never" : localDate(token.expiresAt)}</dd>
      </div>
      <div>
        <dt>Saved</dt>
        <dd>{timeAgo(token.savedAt, now)}</dd>
      </div>
    </dl>
    {token.warnings.length > 0 && (
      <ul className="token-warnings" aria-label="Warnings">
        {token.warnings.map((w) => (
          <li key={w}>
            <span className="status-pill tone-warn">{TOKEN_WARNING_LABEL[w]}</span>{" "}
            {TOKEN_WARNING_TEXT[w]}
          </li>
        ))}
      </ul>
    )}
  </>
);
