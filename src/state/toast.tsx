import { secureId } from '../utils/id';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  detail?: string;
  /** Optional inline action, e.g. "Retry". */
  action?: { label: string; onClick: () => void };
  createdAt: number;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id' | 'createdAt'> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback<ToastContextValue['push']>(
    (input) => {
      const id = secureId('toast');
      const toast: Toast = {
        id,
        variant: input.variant,
        message: input.message,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.action ? { action: input.action } : {}),
        createdAt: Date.now(),
      };
      setToasts((current) => {
        const deduped = current.filter(
          (existing) => !(existing.message === toast.message && existing.variant === toast.variant),
        );
        return [...deduped, toast].slice(-4);
      });
      const timer = setTimeout(() => dismiss(id), input.durationMs ?? DEFAULT_DURATION);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  const clear = useCallback(() => {
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
    setToasts([]);
  }, []);

  const value = useMemo(() => ({ toasts, push, dismiss, clear }), [toasts, push, dismiss, clear]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}
