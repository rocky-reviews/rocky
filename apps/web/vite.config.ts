import { defineConfig } from "vite";
import { devProxy, devProxyTarget } from "./src/dev-proxy.js";

/**
 * H4-2: only the dev server's proxy to the Rocky server (`src/dev-proxy.ts`). The build is
 * Vite's defaults, as before: nothing here changes what production serves.
 */
export default defineConfig(() => {
  const proxy = devProxy(devProxyTarget(process.env));
  return {
    server: { host: "127.0.0.1", ...(proxy === undefined ? {} : { proxy }) },
    // `vite preview` would reuse the dev proxy; the production build is served by the server.
    preview: { proxy: {} },
  };
});
