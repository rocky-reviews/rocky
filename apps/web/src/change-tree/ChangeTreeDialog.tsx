/**
 * The change tree modal (H4-12, mockup "A · Compact tree"): what changed where, folded. Opened
 * from the sidebar's Tree button, `t` and the briefing's "View as tree" link. A modal like the
 * shortcuts dialog: the shell makes the rest of the page inert and returns focus to the opener,
 * focus starts on Close, Tab stays inside, and Escape or a click outside closes it. The tree is
 * nested lists with disclosure buttons (aria-expanded / aria-controls); a file opens in the diff
 * through the shell's own select path, which closes the modal.
 *
 * Paths are untrusted text: React text children in <bdi>, full paths in `title` and the name.
 */
import { useEffect, useRef, useState } from "react";
import { trapTab } from "../shell/focus-trap.js";
import {
  type ChangeTree,
  initialOpen,
  type OpenState,
  ROOT_CONFIG,
  type TreeFile,
  type TreeFolder,
  type TreeLevel,
} from "./change-tree-model.js";

type Props = {
  tree: ChangeTree;
  /** The file on screen, highlighted; null on the briefing. */
  selected: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fmt = (n: number) => n.toLocaleString("en-US");
const LEVELS: readonly TreeLevel[] = ["critical", "important", "normal"];
const LEVEL_WORD: Record<TreeFile["level"], string> = {
  critical: "critical",
  important: "important",
  normal: "normal",
  unanalysed: "not analysed",
  ignore: "ignore",
};

const Caret = () => (
  <svg
    className="ct-caret"
    width="10"
    height="10"
    viewBox="0 0 10 10"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M3 1.5 7 5 3 8.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Lines changed: "+34 −3" on screen, words for screen readers. */
const Lines = ({ additions, deletions }: { additions: number; deletions: number }) => (
  <span className="ct-lines">
    <span aria-hidden="true">
      +{fmt(additions)}
      {deletions > 0 && <span className="ct-del"> −{fmt(deletions)}</span>}
    </span>
    <span className="sr-only">
      , {plural(additions, "line", "lines")} added
      {deletions > 0 && `, ${fmt(deletions)} removed`}
    </span>
  </span>
);

const RiskBar = ({ byLevel }: { byLevel: Record<TreeLevel, number> }) => {
  const present = LEVELS.filter((l) => byLevel[l] > 0);
  return (
    <span
      className="ct-bar"
      role="img"
      aria-label={present.map((l) => `${byLevel[l]} ${l}`).join(", ")}
    >
      {present.map((l) => (
        <i key={l} className={`r-${l}`} style={{ flexGrow: byLevel[l] }} />
      ))}
    </span>
  );
};

export const ChangeTreeDialog = ({ tree, selected, onOpenFile, onClose }: Props) => {
  const [open, setOpen] = useState<OpenState>(() => initialOpen(tree, selected));
  // "+ N more files" is replaced by the files; focus moves to the first of them.
  const [focusMore, setFocusMore] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") trapTab(event, "#change-tree-dialog");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleFolder = (id: string) =>
    setOpen((s) => {
      const folders = new Set(s.folders);
      if (!folders.delete(id)) folders.add(id);
      return { ...s, folders };
    });
  const unfold = (id: string) => {
    setOpen((s) => ({ ...s, more: new Set([...s.more, id]) }));
    setFocusMore(id);
  };

  const fileItem = (file: TreeFile, full: boolean, focus = false) => {
    const sel = file.path === selected;
    return (
      <li key={file.path} className={`ct-file r-${file.level}${sel ? " sel" : ""}`}>
        <div className="ct-row">
          <button
            type="button"
            className="ct-file-btn"
            title={file.path}
            aria-label={`Open ${file.path} (${LEVEL_WORD[file.level]})`}
            aria-current={sel ? "true" : undefined}
            data-path={file.path}
            ref={
              focus
                ? (el) => {
                    if (el === null) return;
                    el.focus();
                    setFocusMore(null);
                  }
                : undefined
            }
            onClick={() => onOpenFile(file.path)}
          >
            <span className={`ct-dot r-${file.level}`} aria-hidden="true" />
            <span className="ct-name">
              <bdi>{full ? file.path : file.name}</bdi>
            </span>
          </button>
          <span className="ct-count">{file.test ? "test" : ""}</span>
          <Lines additions={file.additions} deletions={file.deletions} />
          <span />
        </div>
      </li>
    );
  };

  const folderItem = (folder: TreeFolder) => {
    const isOpen = open.folders.has(folder.id);
    const { summary } = folder;
    const listed = !folder.foldRest || open.more.has(folder.id);
    const root = folder.name === ROOT_CONFIG;
    return (
      <li key={folder.id} className="ct-folder">
        <div className="ct-row">
          <button
            type="button"
            className="ct-toggle"
            aria-expanded={isOpen}
            aria-controls={`ct-${folder.id}`}
            title={root ? "Files at the repository root" : folder.path}
            onClick={() => toggleFolder(folder.id)}
          >
            <Caret />
            <span className={`ct-dot r-${summary.worst}`} aria-hidden="true" />
            <span className="ct-name">
              <bdi>{root ? folder.name : `${folder.name}/`}</bdi>
            </span>
            {summary.isNew && <span className="ct-tag">new</span>}
          </button>
          <span className="ct-count">
            {/* On a phone the two parts stack; the "·" ends the first line, never starts one. */}
            <span>
              {plural(summary.files, "file", "files")}
              {summary.toRead > 0 && " ·"}
            </span>
            {summary.toRead > 0 && (
              <>
                {" "}
                <span>{summary.toRead} to read</span>
              </>
            )}
          </span>
          <Lines additions={summary.additions} deletions={summary.deletions} />
          <RiskBar byLevel={summary.byLevel} />
        </div>
        <ul id={`ct-${folder.id}`} className="ct-list" hidden={!isOpen}>
          {folder.folders.map(folderItem)}
          {folder.key.map((f) => fileItem(f, false))}
          {listed
            ? folder.rest.map((f, i) => fileItem(f, false, i === 0 && focusMore === folder.id))
            : folder.rest.length > 0 && (
                <li className="ct-more">
                  <button type="button" className="ct-more-btn" onClick={() => unfold(folder.id)}>
                    + {folder.rest.length} more {folder.rest.length === 1 ? "file" : "files"}
                    {folder.restTests > 0 && ` (${plural(folder.restTests, "test", "tests")})`}
                  </button>
                </li>
              )}
        </ul>
      </li>
    );
  };

  const { ignored, unanalysed } = tree;
  return (
    <div className="modal-layer modal-layer-top">
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div
        id="change-tree-dialog"
        className="modal change-tree-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-tree-title"
      >
        <div className="modal-head">
          <h2 id="change-tree-title">Change tree</h2>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label="Close"
            ref={close}
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="modal-section ct-body">
          <p className="ct-lede">
            <b>{tree.total}</b> {tree.total === 1 ? "file" : "files"} in <b>{tree.folderCount}</b>{" "}
            {tree.folderCount === 1 ? "folder" : "folders"} · <b>{tree.toRead}</b> to read carefully
          </p>
          <ul className="ct-tree" aria-label="Changed folders">
            {tree.folders.map(folderItem)}
            {unanalysed.length > 0 && (
              <li className="ct-folder ct-unanalysed">
                <div className="ct-row">
                  <span className="ct-head">
                    <span className="ct-caret-space" />
                    <span className="ct-dot r-unanalysed" aria-hidden="true" />
                    <span className="ct-name">Not analysed</span>
                  </span>
                  <span className="ct-count">{plural(unanalysed.length, "file", "files")}</span>
                  <Lines
                    additions={unanalysed.reduce((n, f) => n + f.additions, 0)}
                    deletions={unanalysed.reduce((n, f) => n + f.deletions, 0)}
                  />
                  <span className="ct-bar" aria-hidden="true" />
                </div>
                <ul className="ct-list">{unanalysed.map((f) => fileItem(f, true))}</ul>
              </li>
            )}
            {ignored.files.length > 0 && (
              <li className="ct-folder ct-ignored">
                <div className="ct-row">
                  <button
                    type="button"
                    className="ct-toggle"
                    aria-expanded={open.ignored}
                    aria-controls="ct-ignored"
                    onClick={() => setOpen((s) => ({ ...s, ignored: !s.ignored }))}
                  >
                    <Caret />
                    <span className="ct-dot r-ignore" aria-hidden="true" />
                    <span className="ct-name">Ignored · low risk and noise</span>
                  </button>
                  <span className="ct-count">{plural(ignored.files.length, "file", "files")}</span>
                  <Lines additions={ignored.additions} deletions={ignored.deletions} />
                  <span className="ct-bar" aria-hidden="true" />
                </div>
                <ul id="ct-ignored" className="ct-list" hidden={!open.ignored}>
                  {ignored.files.map((f) => fileItem(f, true))}
                </ul>
              </li>
            )}
          </ul>
          <p className="ct-legend" aria-hidden="true">
            <span>
              <span className="ct-dot r-critical" />
              Critical
            </span>
            <span>
              <span className="ct-dot r-important" />
              Important
            </span>
            <span>
              <span className="ct-dot r-normal" />
              Normal
            </span>
            {unanalysed.length > 0 && (
              <span>
                <span className="ct-dot r-unanalysed" />
                Not analysed
              </span>
            )}
            <span>
              <span className="ct-dot r-ignore" />
              Ignore
            </span>
            <span>Bar: each folder&apos;s files by risk</span>
          </p>
        </div>
      </div>
    </div>
  );
};
