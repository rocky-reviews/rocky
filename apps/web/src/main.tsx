import "./styles/tokens.css";
import "@rocky-reviews/renderer/change-map.css";
import "./styles/shell.css";
import "./styles/diff.css";
import "./briefing/briefing.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createFixtureDiffSource, fixturePullFromSearch } from "./data/diff-fixture-source.js";
import { createFixtureSource } from "./data/fixture-source.js";
import { DiffProvider } from "./diff/DiffProvider.js";

// Until the server serves the shell's data, the fixtures stand in.
const source = createFixtureSource();
// P6-3: the diff has its own port; `?fixture=large-diff` opens the 5,000-line fixture, and
// `?pr=<number>` the briefing's other fixture states (P6-2).
const diffSource = createFixtureDiffSource();
const pull = fixturePullFromSearch(window.location.search);

const root = document.querySelector("#app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DiffProvider source={diffSource} pull={pull}>
        <App source={source} pull={pull} />
      </DiffProvider>
    </StrictMode>,
  );
}
