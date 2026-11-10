import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from './cx.ts';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  action?: { label: string; onAction: () => void };
  /** Defaults to 5 s, or 10 s when there is an action. The timer pauses on hover and focus. */
  durationMs?: number;
}

interface ToastApi {
  show: (toast: ToastOptions) => void;
  /** Toast whose action undoes what just happened (S-6). `onUndo` runs at most once. */
  undo: (message: string, onUndo: () => void) => void;
}

interface ToastProviderProps {
  children: ReactNode;
  /** Accessible names, passed through t() by the app. */
  regionLabel: string;
  dismissLabel: string;
  undoLabel: string;
}

const ToastContext = createContext<ToastApi | null>(null);

const tones: Record<ToastTone, string> = {
  neutral: 'bg-fg text-bg',
  success: 'bg-success-soft text-success-strong',
  danger: 'bg-danger-soft text-danger-strong',
};

/** Hosts the toast stack. Mount once near the app root. */
export function ToastProvider({
  children,
  regionLabel,
  dismissLabel,
  undoLabel,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<Array<ToastOptions & { id: number }>>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const show = (toast: ToastOptions) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...toast, id }]);
    };
    return {
      show,
      undo: (message, onUndo) => show({ message, action: { label: undoLabel, onAction: onUndo } }),
    };
  }, [undoLabel]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label={regionLabel}
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4"
      >
        {/* Errors interrupt (role="alert"); everything else waits its turn. Both containers
            stay mounted, because screen readers ignore live regions added with their content. */}
        <div role="alert" className="contents">
          {toasts
            .filter((t) => t.tone === 'danger')
            .map((t) => (
              <Toast key={t.id} {...t} dismissLabel={dismissLabel} dismiss={dismiss} />
            ))}
        </div>
        <div aria-live="polite" className="contents">
          {toasts
            .filter((t) => t.tone !== 'danger')
            .map((t) => (
              <Toast key={t.id} {...t} dismissLabel={dismissLabel} dismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

function Toast({
  id,
  message,
  tone = 'neutral',
  action,
  durationMs,
  dismissLabel,
  dismiss,
}: ToastOptions & { id: number; dismissLabel: string; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const acted = useRef(false);
  const duration = durationMs ?? (action ? 10_000 : 5_000);

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(id), duration);
    return () => clearTimeout(timer);
  }, [paused, duration, id, dismiss]);

  const actionClass = 'min-h-target rounded-control px-3 font-semibold underline-offset-4';

  return (
    <div
      className={cx(
        'pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-card py-2 pr-2 pl-4',
        'shadow-lg',
        tones[tone],
      )}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p className="flex-1">{message}</p>
      {action ? (
        <button
          type="button"
          className={cx(actionClass, 'underline')}
          onClick={() => {
            if (acted.current) return;
            acted.current = true;
            action.onAction();
            dismiss(id);
          }}
        >
          {action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={dismissLabel}
        className={actionClass}
        onClick={() => dismiss(id)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
