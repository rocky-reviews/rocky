/**
 * The right panel's frame: the Review tab (P6-4) and the shortcut strip under it (P6-5); Ask
 * (P9-2) joins it later.
 */
import { ReviewPanelContent } from "../drafts/ReviewPanel.js";
import { ShortcutStrip } from "../keyboard/ShortcutStrip.js";

/** `current`: the file on screen, or null on the briefing (H4-14: its drafts are listed first). */
export const RightPanelContent = ({ current }: { current: string | null }) => (
  <>
    <ReviewPanelContent current={current} />
    <ShortcutStrip />
  </>
);
