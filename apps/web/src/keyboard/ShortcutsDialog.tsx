/**
 * The shortcuts dialog (P6-5, POC `openHelp`): every key and what it does, and the switch that
 * turns single-key shortcuts off (WCAG 2.1.4, ADR 0030). A modal: the shell makes the rest of
 * the page inert, focus starts on Close, Tab stays inside, and Escape or a click outside closes
 * it; the shell then returns focus to where it was.
 */
import { Fragment, useEffect, useRef } from "react";
import { trapTab } from "../shell/focus-trap.js";
import { finishKeys, HELP_ROWS, isMac } from "./keymap.js";

const MAC = typeof navigator !== "undefined" && isMac(navigator.userAgent);

type Props = {
  singleKeys: boolean;
  /** False once saving the choice failed (storage blocked): it then lasts until a reload. */
  remembered: boolean;
  onSingleKeys: (on: boolean) => void;
  onClose: () => void;
};

export const ShortcutsDialog = ({ singleKeys, remembered, onSingleKeys, onClose }: Props) => {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") trapTab(event, "#shortcuts-dialog");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-layer">
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div
        id="shortcuts-dialog"
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <div className="modal-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
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
        <dl className="modal-section shortcuts-grid" data-off={!singleKeys}>
          {HELP_ROWS.map((row) => (
            <div key={row.label} className={row.single && !singleKeys ? "off" : undefined}>
              <dt>
                {row.keys.map((k, i) => (
                  <Fragment key={k}>
                    {i > 0 && <span className="sep"> / </span>}
                    <kbd>{k === "finish" ? finishKeys(MAC) : k}</kbd>
                  </Fragment>
                ))}
              </dt>
              <dd>{row.label}</dd>
            </div>
          ))}
        </dl>
        <div className="modal-section shortcuts-setting">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={singleKeys}
              aria-describedby="single-keys-note"
              onChange={(e) => onSingleKeys(e.target.checked)}
            />
            <span>Single-key shortcuts</span>
          </label>
          <p id="single-keys-note" className="note">
            Turn these off if single letters get in your way, for example with speech input. Esc and{" "}
            {finishKeys(MAC)} keep working.{" "}
            {remembered ? (
              "Remembered in this browser."
            ) : (
              <span role="status">
                This browser could not save the choice, so it lasts until you reload the page.
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};
