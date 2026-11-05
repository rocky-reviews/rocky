/**
 * The right panel's frame: the Review tab (P6-4) and the shortcut strip under it (P6-5); Ask
 * (P9-2) joins it later.
 */
import { ReviewPanelContent } from "../drafts/ReviewPanel.js";
import { ShortcutStrip } from "../keyboard/ShortcutStrip.js";

/**
 * `current`: the file on screen, or null on the briefing; `files`: the sidebar's order (H4-14:
 * the open file's drafts first, then the next files').
 */
export const RightPanelContent = ({
  current,
  files,
}: {
  current: string | null;
  files: readonly string[];
}) => (
  <>
    <ReviewPanelContent current={current} files={files} />
    <ShortcutStrip />
  </>
);
