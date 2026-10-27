// P6-1: sets <html data-mode> before the first paint, so the page never flashes the wrong
// theme. A classic, render-blocking script in <head> (no inline script, so a strict CSP needs
// no hash). Same rule as src/theme.ts: the saved choice, otherwise the system preference.
(function () {
  var saved = null;
  try {
    saved = window.localStorage.getItem("rocky-mode");
  } catch {
    // Storage blocked (private mode, sandboxed frame): fall back to the system preference.
  }
  var dark = false;
  try {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    // No matchMedia: light.
  }
  var mode = saved === "light" || saved === "dark" ? saved : dark ? "dark" : "light";
  document.documentElement.dataset.mode = mode;
  document.documentElement.style.colorScheme = mode;
})();
