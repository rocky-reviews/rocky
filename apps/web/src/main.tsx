import "./styles/tokens.css";
import "./styles/shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createFixtureSource, DEFAULT_PULL } from "./data/fixture-source.js";

// Until the server serves the shell's data (P7-1, P6-2), the pr-847 fixture stands in.
const source = createFixtureSource();

const root = document.querySelector("#app");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App source={source} pull={DEFAULT_PULL} />
    </StrictMode>,
  );
}
