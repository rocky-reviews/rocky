import type { ReactNode } from "react";

/** Small line icons for the panel toggles; they take the button's text colour. */
const Frame = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    {children}
  </svg>
);

export const SidebarIcon = () => (
  <Frame>
    <path d="M6 3v10" />
  </Frame>
);

export const PanelIcon = () => (
  <Frame>
    <path d="M10 3v10" />
  </Frame>
);
