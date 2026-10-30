/**
 * Short confirmations at the bottom of the page (POC `toast`, P6-4): "Added to your pending
 * review. Not posted yet.", "Fix prompt copied…". The live region is always in the page, so
 * screen readers announce each message; a message stays a few seconds, a new one replaces it.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const TOAST_MS = 4000;

type Toast = { readonly id: number; readonly text: string };

const ToastContext = createContext<(text: string) => void>(() => {});

export const useToast = (): ((text: string) => void) => useContext(ToastContext);

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toast, setToast] = useState<Toast | null>(null);
  const next = useRef(1);
  const show = useCallback((text: string) => setToast({ id: next.current++, text }), []);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const value = useMemo(() => show, [show]);
  return (
    <ToastContext value={value}>
      {children}
      {/* A live region without the status role: the page's own status messages stay unique. */}
      <div className="toast-region" aria-live="polite" aria-atomic="true">
        {toast !== null && (
          <p key={toast.id} className="toast">
            {toast.text}
          </p>
        )}
      </div>
    </ToastContext>
  );
};
