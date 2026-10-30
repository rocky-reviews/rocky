import { codePoint, splitControls } from "./text.js";
import { type Language, tokenize } from "./tokenize.js";

/** Code as highlighted text; invisible characters show as visible markers. P6-3. */
export const Code = ({ text, language }: { text: string; language: Language }) =>
  tokenize(text, language).map((token, i) => {
    const parts = splitControls(token.text).map((part, j) =>
      part.control ? (
        <span key={j} className="bidi-ctl" title={`Invisible character ${codePoint(part.text)}`}>
          {codePoint(part.text)}
        </span>
      ) : (
        part.text
      ),
    );
    return token.kind === "plain" ? (
      <span key={i}>{parts}</span>
    ) : (
      <span key={i} className={`tk-${token.kind}`}>
        {parts}
      </span>
    );
  });
