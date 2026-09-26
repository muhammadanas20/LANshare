import { cn } from '../utils/cn';

interface LogoProps {
  size?: number;
  className?: string;
  /** Animated node pulse for the loading screen. */
  animated?: boolean;
  title?: string;
}

/**
 * Original LANShare mark: two device nodes joined by a bidirectional transfer arrow
 * inside a rounded "signal" tile. Drawn from scratch with the accent token.
 */
export function Logo({ size = 34, className, animated = false, title = 'LANShare' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id="lanshare-mark" x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="color-mix(in srgb, var(--accent) 60%, var(--success))" />
        </linearGradient>
      </defs>
      <rect x="2.5" y="2.5" width="43" height="43" rx="13" fill="url(#lanshare-mark)" opacity="0.14" />
      <rect
        x="3.5"
        y="3.5"
        width="41"
        height="41"
        rx="12"
        fill="none"
        stroke="url(#lanshare-mark)"
        strokeWidth="2"
      />
      {/* bidirectional link */}
      <path
        d="M15.5 18.5h16"
        stroke="url(#lanshare-mark)"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M28.6 15.2 32 18.5l-3.4 3.3" stroke="url(#lanshare-mark)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M32.5 29.5h-16" stroke="url(#lanshare-mark)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M19.4 26.2 16 29.5l3.4 3.3" stroke="url(#lanshare-mark)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* nodes */}
      <circle cx="12.5" cy="18.5" r="3.6" fill="var(--accent)" />
      <circle cx="35.5" cy="29.5" r="3.6" fill="var(--success)" />
      {animated && (
        <circle cx="12.5" cy="18.5" r="3.6" fill="none" stroke="var(--accent)" strokeWidth="1.6" className="animate-pulse-ring" style={{ transformOrigin: '12.5px 18.5px' }} />
      )}
    </svg>
  );
}

export function LogoWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-[1.05rem] font-semibold tracking-tight text-text">LANShare</span>
      {!compact && <span className="hidden text-xs text-muted sm:inline">Fast nearby sharing</span>}
    </span>
  );
}
