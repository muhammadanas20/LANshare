import { APP_NAME, CREATOR, TAGLINE } from '../config';
import { Logo } from './Logo';

/** Short, calm boot animation — shown only while the first connection is establishing. */
export function LoadingScreen({ status }: { status: 'connecting' | 'ready' }) {
  return (
    // While this overlay is on screen the app shell behind it is not usable yet, so the
    // boot screen *is* the main content (a plain div here would leave its text outside any
    // landmark). Once ready it is faded out and `aria-hidden`, so it leaves the a11y tree.
    <main
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-background px-6 text-center transition-opacity duration-300"
      style={{ opacity: status === 'ready' ? 0 : 1, pointerEvents: status === 'ready' ? 'none' : 'auto' }}
      aria-hidden={status === 'ready'}
    >
      <div className="flex flex-col items-center gap-4">
        <Logo size={64} animated />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-muted">{TAGLINE}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm text-muted" role="status" aria-live="polite">
        <span className="relative flex h-3 w-3 items-center justify-center">
          <span className="absolute inline-flex h-3 w-3 rounded-full bg-accent/40 animate-pulse-ring" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <span>Connecting to nearby devices…</span>
      </div>

      <p className="absolute bottom-6 text-xs text-muted">
        Built by <span className="font-medium text-text">{CREATOR}</span>
      </p>
    </main>
  );
}
