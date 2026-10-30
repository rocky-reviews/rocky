/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** H4-2: `on` makes a build honour the fixture switches (`main.tsx`); tests only. */
  readonly VITE_ROCKY_FIXTURES?: string;
}
