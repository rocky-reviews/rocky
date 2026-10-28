import "./styles/tokens.css";
import "./styles/shell.css";
import "./briefing/briefing.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createFixtureSource, DEFAULT_PULL } from "./data/fixture-source.js";

// Until the server serves the shell's data, the fixtures stand in: pr-847 by default, or the
// fixture PR named by `?pr=<number>` (the briefing's other states, P6-2).
const source = createFixtureSource();
const requested = Number(new URLSearchParams(window.location.search).get("pr"));
const pull =
  Number.isSafeInteger(requested) && requested > 0
    ? { ...DEFAULT_PULL, number: requested }
    : DEFAULT_PULL;

const root = document.querySelector("#app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App source={source} pull={pull} />
    </StrictMode>,
  );
}
