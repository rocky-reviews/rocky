import { codeSpans } from "./text.js";

/** AI prose with `code` spans (flags, noise summaries), rendered as text. P6-3. */
export const Prose = ({ text }: { text: string }) =>
  codeSpans(text).map((part, i) =>
    part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>,
  );
