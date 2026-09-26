import { CheckCircle2, Info, TriangleAlert, XCircle } from 'lucide-react';
import { useToast } from '../state/toast';
import { cn } from '../utils/cn';

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: TriangleAlert,
  info: Info,
} as const;

const TONES: Record<string, string> = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-accent',
};

/** Toast viewport — announced politely for screen readers. */
export function ToastViewport() {
  const { toasts, dismiss } = useToast();

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end"
      role="region"
      aria-label="Notifications"
    >
      <div aria-live="polite" aria-atomic="false" className="flex w-full flex-col items-center gap-2 sm:items-end">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.variant];
          return (
            <div
              key={toast.id}
              className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-lift animate-fade-in-up"
            >
              <Icon size={18} className={cn('mt-0.5 shrink-0', TONES[toast.variant])} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">{toast.message}</p>
                {toast.detail && <p className="mt-0.5 text-xs leading-relaxed text-muted">{toast.detail}</p>}
                {toast.action && (
                  <button
                    type="button"
                    className="mt-2 text-xs font-semibold text-accent underline-offset-2 hover:underline"
                    onClick={() => {
                      toast.action?.onClick();
                      dismiss(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                className="icon-btn -mr-2 -mt-1 h-8 w-8 shrink-0"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
              >
                <span aria-hidden="true" className="text-lg leading-none">
                  ×
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
