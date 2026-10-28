/** "updated N ago" in the top bar. Coarse on purpose: it is a hint, not a timestamp. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const timeAgo = (iso: string, now: number): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const elapsed = now - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? "1 day ago" : `${days} days ago`;
};
