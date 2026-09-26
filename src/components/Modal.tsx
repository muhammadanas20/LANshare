import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Bottom-sheet presentation on small screens. */
  variant?: 'center' | 'sheet';
  size?: 'sm' | 'md' | 'lg';
  labelledBy?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Accessible dialog: focus trap, Escape to close, backdrop click, `aria-modal`,
 * scroll lock and automatic focus restoration.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'center',
  size = 'md',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  /**
   * `onClose` is almost always an inline arrow function, so it must not be an effect
   * dependency — otherwise every parent re-render (e.g. every transfer progress tick)
   * would re-run the focus logic and yank focus out of whatever the user is typing in.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Only claim focus once, and never fight with the element the user is already using.
    if (!panel?.contains(document.activeElement)) {
      const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel)?.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (nodes.length === 0) return;
      const firstNode = nodes[0] as HTMLElement;
      const lastNode = nodes[nodes.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      const returnTo = previouslyFocused.current;
      if (returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="presentation">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px] animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={description ? `${title}-desc` : undefined}
        tabIndex={-1}
        className={cn(
          'relative z-10 flex w-full flex-col border border-border bg-surface shadow-lift',
          sizes[size],
          variant === 'sheet'
            ? 'max-h-[92dvh] rounded-t-3xl sm:rounded-3xl animate-fade-in-up'
            : 'max-h-[92dvh] rounded-3xl animate-scale-in',
          'safe-bottom',
        )}
      >
        {/*
          A <header> here would become a second `banner` landmark: the dialog root is a plain
          div with role="dialog", which is not sectioning content, so the element keeps its
          banner mapping. The dialog already carries aria-label/aria-describedby.
        */}
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-text">{title}</h2>
            {description && (
              <p id={`${title}-desc`} className="mt-1 text-sm text-muted">
                {description}
              </p>
            )}
          </div>
          <button type="button" className="icon-btn -mr-1 -mt-1" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>
        <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-border px-5 py-4">{footer}</footer>}
      </div>
    </div>
  );
}
