import "./styles/tokens.css";
import "@rocky-reviews/renderer/change-map.css";
import "./styles/shell.css";
import "./styles/diff.css";
import "./briefing/briefing.css";
import "./inbox/inbox.css";
import "./drafts/drafts.css";
import "./keyboard/keyboard.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createFixtureDiffSource, fixturePullFromSearch } from "./data/diff-fixture-source.js";
import { createFixtureSource } from "./data/fixture-source.js";
import { createHttpReviewSource } from "./data/review-http-source.js";
import { DiffProvider } from "./diff/DiffProvider.js";
import { createFixtureInboxSource, createHttpInboxSource } from "./inbox/inbox-source.js";
import { InboxPage } from "./inbox/InboxPage.js";

const root = document.querySelector("#app");

if (root && window.location.pathname === "/inbox") {
  // P6-7: the inbox. The fixture stands in until every page reads the server; `?source=api`
  // reads the server's /api/inbox (same origin) instead.
  const api = new URLSearchParams(window.location.search).get("source") === "api";
  const source = api ? createHttpInboxSource() : createFixtureInboxSource();
  createRoot(root).render(
    <StrictMode>
      <InboxPage source={source} />
    </StrictMode>,
  );
} else if (root) {
  // Until the server serves the shell's data, the fixtures stand in.
  const source = createFixtureSource();
  // P6-3: the diff has its own port; `?fixture=large-diff` opens the 5,000-line fixture, and
  // `?pr=<number>` the briefing's other fixture states (P6-2).
  const diffSource = createFixtureDiffSource();
  const pull = fixturePullFromSearch(window.location.search);
  // P6-4: drafts and own comments are kept by the server (ADR 0027), keyed by the analysis id.
  const review = createHttpReviewSource();
  createRoot(root).render(
    <StrictMode>
      <DiffProvider source={diffSource} pull={pull}>
        <App source={source} pull={pull} review={review} />
      </DiffProvider>
    </StrictMode>,
  );
}
