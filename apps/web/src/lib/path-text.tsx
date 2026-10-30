/**
 * P6-9: a file path that wraps after a "/" before it breaks inside a name. Each "/" is followed
 * by a <wbr>; CSS `overflow-wrap: anywhere` stays the fallback for a single name too long for
 * the line. The path is a React text child in a <bdi>, never markup.
 */
import { Fragment } from "react";

export const PathText = ({ path }: { path: string }) => {
  const parts = path.split("/");
  return (
    <bdi>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </bdi>
  );
};
