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
import type { DiffDataSource } from "./data/diff-data.js";
import { createHttpDiffSource } from "./data/diff-http-source.js";
import { createHttpPostingSource } from "./data/posting-http-source.js";
import { createHttpReviewSource } from "./data/review-http-source.js";
import type { PullRef, ShellDataSource } from "./data/shell-data.js";
import { createHttpShellSource } from "./data/shell-http-source.js";
import { DiffProvider } from "./diff/DiffProvider.js";
import { createHttpInboxSource, type InboxSource } from "./inbox/inbox-source.js";
import { InboxPage } from "./inbox/InboxPage.js";
import { pageFor } from "./route.js";

const root = document.querySelector("#app");
// H4-2 (review S2): the fixture switches work only in the Vite dev server and in builds made with
// `VITE_ROCKY_FIXTURES=on` (the Playwright `perf` build). Vite replaces both at build time; the
// condition is written out here, not imported, so the bundler folds it to `false` in a
// production build and drops the fixture branches and their chunks (bundle-budget.test.ts checks).
const FIXTURES_ENABLED = import.meta.env.DEV || import.meta.env.VITE_ROCKY_FIXTURES === "on";
// H4-2: the server by default; the fixtures only behind an explicit switch, and only in
// development and test builds.
const page = pageFor(window.location.pathname, window.location.search, {
  fixtures: FIXTURES_ENABLED,
});

const renderInbox = (element: Element, source: InboxSource) =>
  createRoot(element).render(
    <StrictMode>
      <InboxPage source={source} />
    </StrictMode>,
  );

const renderPull = (
  element: Element,
  pull: PullRef,
  source: ShellDataSource,
  diffSource: DiffDataSource,
) => {
  // P6-4: drafts and own comments are kept by the server (ADR 0027), keyed by the analysis id.
  const review = createHttpReviewSource();
  // P6-6: Finish review reads the exact list and posts it through the server (ADR 0026).
  const posting = createHttpPostingSource();
  createRoot(element).render(
    <StrictMode>
      <DiffProvider source={diffSource} pull={pull} returnTo={window.location.pathname}>
        <App
          source={source}
          pull={pull}
          review={review}
          posting={posting}
          returnTo={window.location.pathname}
        />
      </DiffProvider>
    </StrictMode>,
  );
};

if (page.kind === "home") {
  window.location.replace("/inbox");
} else if (!root) {
  // Nothing to render into.
} else if (FIXTURES_ENABLED && page.kind === "inbox" && page.source === "fixture") {
  // P6-7: the inbox fixture (development and tests only).
  void import("./inbox/inbox-source.js").then(({ createFixtureInboxSource }) =>
    renderInbox(root, createFixtureInboxSource()),
  );
} else if (page.kind === "inbox") {
  renderInbox(root, createHttpInboxSource());
} else if (FIXTURES_ENABLED && page.kind === "pull" && page.source === "fixture") {
  // The fixture PRs (development and tests only): pr-847 (P6-1), the briefing's states
  // (`?pr=`, P6-2), the 5,000-line diff (`?fixture=large-diff`, P6-3) and a later push
  // (`?diff=newer-push`, P6-5).
  void Promise.all([
    import("./data/fixture-source.js"),
    import("./data/diff-fixture-source.js"),
  ]).then(([{ createFixtureSource }, diff]) =>
    renderPull(
      root,
      diff.fixturePullFromSearch(page.search),
      createFixtureSource(),
      diff.createFixtureDiffSource({ newerPush: diff.newerPushFromSearch(page.search) }),
    ),
  );
} else if (page.kind === "pull" && page.source === "server") {
  // H4-3: the diff comes from the server too, read from GitHub when the first file is opened.
  renderPull(root, page.ref, createHttpShellSource(), createHttpDiffSource());
} else {
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
