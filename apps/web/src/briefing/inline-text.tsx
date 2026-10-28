/**
 * Model-written prose (summary, reasons, memory, checks) as React text: `**bold**` and
 * `` `code` `` become elements, everything else stays literal text. No links, no HTML: the schema
 * allows inline markdown only, and anything else in the string is shown as typed. The whole
 * string sits in one `<bdi>` so bidi controls in it cannot reorder the page around it.
 */
import type { ReactNode } from "react";

const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

export const InlineText = ({ text }: { text: string }) => {
  const nodes: ReactNode[] = text.split(TOKEN).map((part, i) => {
    if (i % 2 === 0) return part;
    return part.startsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <code key={i}>{part.slice(1, -1)}</code>
    );
  });
  return <bdi>{nodes}</bdi>;
};
