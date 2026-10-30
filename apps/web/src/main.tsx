import "./styles/tokens.css";
import "@rocky-reviews/renderer/change-map.css";
import "./styles/shell.css";
import "./styles/diff.css";
import "./briefing/briefing.css";
import "./inbox/inbox.css";
import "./drafts/drafts.css";
import "./keyboard/keyboard.css";
import "./finish/finish.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { unavailableDiffSource } from "./data/diff-data.js";
import { createFixtureDiffSource } from "./data/diff-fixture-source.js";
import { createFixtureSource } from "./data/fixture-source.js";
import { createHttpPostingSource } from "./data/posting-http-source.js";
import { createHttpReviewSource } from "./data/review-http-source.js";
import { createHttpShellSource } from "./data/shell-http-source.js";
import { DiffProvider } from "./diff/DiffProvider.js";
import { createFixtureInboxSource, createHttpInboxSource } from "./inbox/inbox-source.js";
import { InboxPage } from "./inbox/InboxPage.js";
import { pageFor } from "./route.js";

const root = document.querySelector("#app");
// H4-2: the server by default; the fixtures only behind an explicit switch (route.ts).
const page = pageFor(window.location.pathname, window.location.search);

if (page.kind === "home") {
  window.location.replace("/inbox");
} else if (root && page.kind === "inbox") {
  // P6-7: the inbox (ADR 0029); `?source=fixture` serves the fixture instead of /api/inbox.
  const source = page.source === "fixture" ? createFixtureInboxSource() : createHttpInboxSource();
  createRoot(root).render(
    <StrictMode>
      <InboxPage source={source} />
    </StrictMode>,
  );
} else if (root && page.kind === "pull") {
  const fixture = page.source === "fixture";
  const source = fixture ? createFixtureSource() : createHttpShellSource();
  // P6-3: the diff has its own port. The fixtures serve pr-847's and the 5,000-line diff
  // (`?fixture=large-diff`); `?diff=newer-push` (P6-5) serves it as a later push. The server
  // does not serve a diff yet (H4-2 follow-up): a real PR's file view says it could not load.
  const diffSource = fixture
    ? createFixtureDiffSource({ newerPush: page.newerPush })
    : unavailableDiffSource;
  // P6-4: drafts and own comments are kept by the server (ADR 0027), keyed by the analysis id.
  const review = createHttpReviewSource();
  // P6-6: Finish review reads the exact list and posts it through the server (ADR 0026).
  const posting = createHttpPostingSource();
  createRoot(root).render(
    <StrictMode>
      <DiffProvider source={diffSource} pull={page.ref}>
        <App
          source={source}
          pull={page.ref}
          review={review}
          posting={posting}
          returnTo={window.location.pathname}
        />
      </DiffProvider>
    </StrictMode>,
  );
} else if (root) {
  createRoot(root).render(
    <StrictMode>
      <main className="status-page" id="main">
        <p>
          There is no page at this address. <a href="/inbox">Go to your inbox</a>.
        </p>
      </main>
    </StrictMode>,
  );
}
