/**
 * The change map's measurements: the POC diagram's (design-poc/index.html, renderDiagram), in
 * one place. Font sizes here must match src/change-map.css: text is measured from a table, not
 * a font engine, so the layout and the stylesheet have to agree on the size.
 */

/** Space around the lanes. */
export const MARGIN = 8;

/** Every lane is the same width, so a long name in one lane never moves the next (PR Lens). */
export const LANE_WIDTH = 184;
export const LANE_GAP = 12;
export const LANE_RADIUS = 10;
export const LANE_LABEL_X = 12;
export const LANE_LABEL_BASELINE = 20;
export const LANE_LABEL_SIZE = 10.5;
/** `letter-spacing: .06em` in the stylesheet. */
export const LANE_LABEL_TRACKING = 0.06;

/** Where the first row of cards starts, under the lane header. */
export const CONTENT_TOP = 34;
/** Row pitch: a card plus the band under it. */
export const ROW_PITCH = 72;
/** A card sits this far below its row's top. */
export const ROW_INSET = 6;
/** Below the last row, before the lane ends. */
export const LANE_BOTTOM = 4;

export const CARD_WIDTH = 156;
export const CARD_HEIGHT = 44;
export const CARD_RADIUS = 8;
export const CARD_PADDING_X = 10;
export const TITLE_SIZE = 12;
export const TITLE_BASELINE = 19;
export const SUBTITLE_SIZE = 10;
export const SUBTITLE_BASELINE = 34;
/** Room the finding badge takes from the title's right end. */
export const BADGE_ROOM = 14;

/** The finding badge rides the card's top-right corner. */
export const BADGE_SIZE = 18;
export const BADGE_INSET = 2;
export const BADGE_TEXT_SIZE = 9.5;
export const BADGE_PADDING_X = 4;
/** Above this the badge shows "9+"; the tooltip carries the exact count. */
export const BADGE_MAX_COUNT = 9;

export const EDGE_LABEL_SIZE = 9.5;
export const PILL_HEIGHT = 14;
export const PILL_PADDING_X = 5;
export const PILL_MAX_TEXT = 120;
/** A pill keeps this far from a card, its badge and the lane headers. */
export const PILL_CARD_CLEARANCE = 3;
/** And this far from another pill. */
export const PILL_CLEARANCE = 2;

/** Rounded corners on routes that turn through the gaps. */
export const BEND_RADIUS = 6;
/** Parallel runs through one gap sit this far apart at most. */
export const TRACK_PITCH = 5;
/** A self-loop's reach to the right of its card. */
export const LOOP_REACH = 20;
