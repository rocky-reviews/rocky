/**
 * The right panel's frame: the Review tab (P6-4) and the shortcut strip under it (P6-5); Ask
 * (P9-2) joins it later.
 */
import { ReviewPanelContent } from "../drafts/ReviewPanel.js";
import { ShortcutStrip } from "../keyboard/ShortcutStrip.js";

export const RightPanelContent = () => (
  <>
    <ReviewPanelContent />
    <ShortcutStrip />
  </>
);
