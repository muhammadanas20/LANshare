import { Download, Monitor, Moon, QrCode, Settings as SettingsIcon, Sun, WifiOff } from 'lucide-react';
import { APP_NAME, config } from '../config';
import { useLanShare } from '../state/lanshare';
import { useSettings } from '../state/settings';
import { Logo } from './Logo';
import { cn } from '../utils/cn';

interface HeaderProps {
  statusLabel: string;
  statusTone: 'ok' | 'warn' | 'error';
  onOpenQr: () => void;
  onOpenSettings: () => void;
  onInstall?: (() => void) | undefined;
  canInstall: boolean;
}

const NEXT_THEME = { light: 'dark', dark: 'system', system: 'light' } as const;
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

export function Header({ statusLabel, statusTone, onOpenQr, onOpenSettings, onInstall, canInstall }: HeaderProps) {
  const { settings, setTheme } = useSettings();
  const { offlineLan } = useLanShare();
  const ThemeIcon = THEME_ICON[settings.theme];

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-[color:var(--background)]/85 backdrop-blur-md">
      <div className="safe-top mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Logo size={30} />
          <div className="min-w-0">
            <h1 className="text-[0.95rem] font-semibold leading-tight tracking-tight">{APP_NAME}</h1>
            <p className="hidden text-[11px] leading-tight text-muted xs:block">
              {settings.displayName || 'This device'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {offlineLan && (
            <span className="chip hidden text-muted md:inline-flex" title="This host is serving LANShare on the local network — no internet is involved.">
              <WifiOff size={12} aria-hidden="true" />
              Offline LAN
            </span>
          )}

          <span
            className={cn(
              'chip hidden sm:inline-flex',
              statusTone === 'ok' && 'text-[color:var(--success)]',
              statusTone === 'warn' && 'text-[color:var(--warning)]',
              statusTone === 'error' && 'text-[color:var(--danger)]',
            )}
            role="status"
          >
            <span
              className="status-dot"
              data-status={statusTone === 'ok' ? 'connected' : statusTone === 'warn' ? 'connecting' : 'failed'}
              aria-hidden="true"
            />
            {statusLabel}
          </span>

          {canInstall && onInstall && (
            <button type="button" className="icon-btn" onClick={onInstall} aria-label="Install LANShare" title="Install app">
              <Download size={17} />
            </button>
          )}

          <button
            type="button"
            className="icon-btn"
            onClick={() => setTheme(NEXT_THEME[settings.theme])}
            aria-label={`Theme: ${settings.theme}. Switch to ${NEXT_THEME[settings.theme]}.`}
            title={`Theme: ${settings.theme}`}
          >
            <ThemeIcon size={17} />
          </button>

          <button type="button" className="icon-btn" onClick={onOpenQr} aria-label="Pair another device" title="Pair device">
            <QrCode size={17} />
          </button>

          <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings" title="Settings">
            <SettingsIcon size={17} />
          </button>
        </div>
      </div>

      {config.signalingMode === 'same-origin' && import.meta.env.DEV && (
        <p className="mx-auto max-w-5xl px-4 pb-2 text-[11px] text-muted">
          Dev mode: signaling via <span className="font-mono">{config.signalingUrl}</span>
        </p>
      )}
    </header>
  );
}
