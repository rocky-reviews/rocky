/**
 * The token field (P10-4): a password input that is emptied the moment the form is sent
 * (`takeToken`), so the token is never shown back, never kept in the page's state and never
 * rendered into the DOM. The refusal, if any, is fixed text from `connection-model.ts`.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { takeToken } from "./connection-model.js";

type Props = {
  label: string;
  submitLabel: string;
  busyLabel: string;
  /** Sends the token; resolves to the refusal's text, or `null` when it was saved. */
  onSubmit: (token: string) => Promise<string | null>;
  /** Shown under the field (what to paste). */
  hint?: string;
  autoFocus?: boolean;
};

export const TokenForm = ({ label, submitLabel, busyLabel, onSubmit, hint, autoFocus }: Props) => {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const token = takeToken(field.current);
    if (token === null) {
      setProblem("Paste a token first.");
      field.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    const refusal = await onSubmit(token);
    setBusy(false);
    setProblem(refusal);
    if (refusal !== null) field.current?.focus();
  };

  return (
    <form className="token-form" onSubmit={(e) => void submit(e)} noValidate>
      <label className="token-field" htmlFor={`${id}-token`}>
        <span>{label}</span>
        <input
          ref={field}
          id={`${id}-token`}
          name="token"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={512}
          // Focus follows the person's own act (opening "Replace token"), not page load.
          autoFocus={autoFocus}
          {...(hint === undefined ? {} : { "aria-describedby": `${id}-hint` })}
          {...(problem === null ? {} : { "aria-invalid": true })}
        />
      </label>
      <button
        type="submit"
        className="btn btn-primary"
        {...(busy ? { "aria-disabled": true } : {})}
      >
        {busy ? busyLabel : submitLabel}
      </button>
      {hint !== undefined && (
        <p className="token-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {problem !== null && (
        <p className="token-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
};
