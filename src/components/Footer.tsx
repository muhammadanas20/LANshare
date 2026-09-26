import { Github, Info, ShieldCheck } from 'lucide-react';
import { APP_NAME, APP_VERSION, CREATOR, REPO_URL, TAGLINE } from '../config';

/** Footer credit — required branding, kept out of the primary workflow. */
export function Footer({ onOpenAbout }: { onOpenAbout: () => void }) {
  return (
    <footer className="mt-10 border-t border-border pt-6 pb-8 text-center text-xs text-muted sm:text-left">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-text">{APP_NAME}</p>
          <p className="mt-0.5 text-balance">Fast local sharing. Private by design.</p>
          <p className="mt-0.5 text-balance">{TAGLINE}</p>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2" aria-label="Footer">
          <a
            className="flex items-center gap-1.5 hover:text-text"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github size={13} aria-hidden="true" />
            GitHub
          </a>
          <button type="button" className="flex items-center gap-1.5 hover:text-text" onClick={onOpenAbout}>
            <Info size={13} aria-hidden="true" />
            About &amp; privacy
          </button>
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={13} aria-hidden="true" />
            v{APP_VERSION}
          </span>
        </nav>
      </div>

      <p className="mt-5 text-center text-[11px] sm:text-left">
        Built by <span className="font-semibold text-text">{CREATOR}</span>
      </p>
    </footer>
  );
}
