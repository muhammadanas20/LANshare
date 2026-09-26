import { useState, type ReactNode } from 'react';
import {
  Bell,
  Check,
  Download,
  FolderOpen,
  Info,
  Monitor,
  Moon,
  RotateCcw,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
} from 'lucide-react';
import { APP_NAME, APP_VERSION, CREATOR, REPO_URL, TAGLINE, config } from '../config';
import { useSettings } from '../state/settings';
import { useLanShare } from '../state/lanshare';
import { useToast } from '../state/toast';
import { wipeLocalData } from '../services/storage';
import { supportsFileSystemAccess } from '../utils/device';
import { isLocalStorageAvailable } from '../utils/safeStorage';
import { Modal } from './Modal';
import { cn } from '../utils/cn';
import type { ThemePreference } from '../services/storage';

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">{title}</p>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border transition',
        checked ? 'border-transparent bg-[color:var(--accent)]' : 'border-border bg-[color:var(--surface-secondary)]',
      )}
    >
      <span
        className={cn('absolute top-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')}
        style={{ width: 18, height: 18 }}
      />
    </button>
  );
}

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    settings,
    update,
    setTheme,
    setDisplayName,
    setNotifications,
    setSaveBehavior,
    resetOnboarding,
    notificationPermission,
  } = useSettings();
  const { receiveFolderName, chooseReceiveFolder, forgetReceiveFolder, wipeHistory, history, roomId } = useLanShare();
  const toast = useToast();
  const [nameDraft, setNameDraft] = useState(settings.displayName);
  const [showPrivacy, setShowPrivacy] = useState(false);

  const saveName = () => {
    const clean = nameDraft.trim();
    if (!clean) {
      setNameDraft(settings.displayName);
      return;
    }
    setDisplayName(clean);
    toast.push({ variant: 'success', message: 'Device name updated' });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      description={
        isLocalStorageAvailable()
          ? 'Preferences are stored on this device only.'
          : 'Preferences are kept for this session only — this browser context blocks local storage.'
      }
      variant="sheet"
      size="md"
    >
      <div className="divide-y divide-[color:var(--border)]">
        <section className="pb-3">
          <p className="label flex items-center gap-2">
            <Sun size={13} aria-hidden="true" /> Appearance
          </p>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setTheme(value)}
                aria-pressed={settings.theme === value}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs font-medium transition',
                  settings.theme === value
                    ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-text'
                    : 'border-border bg-[color:var(--surface)] text-muted hover:border-[color:var(--border-strong)]',
                )}
              >
                <Icon size={17} />
                {label}
                {settings.theme === value && <Check size={12} className="text-accent" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </section>

        <section className="py-3">
          <p className="label flex items-center gap-2">
            <UserRound size={13} aria-hidden="true" /> Device name
          </p>
          <div className="flex gap-2">
            <input
              className="input"
              value={nameDraft}
              maxLength={32}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveName();
              }}
              aria-label="Device name shown to nearby devices"
              placeholder="e.g. Anas Laptop"
            />
            <button type="button" className="btn btn-secondary px-4" onClick={saveName}>
              Save
            </button>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            Shown to nearby devices only. No IP address, operating system or browser details are ever shared.
          </p>
        </section>

        <section className="py-1">
          <Row
            title="Notifications"
            description={
              notificationPermission === 'unsupported'
                ? 'Not supported by this browser.'
                : 'Show a system notification when a transfer arrives while the tab is in the background.'
            }
          >
            <Toggle
              label="Enable notifications"
              checked={settings.notifications}
              onChange={async (value) => {
                const ok = await setNotifications(value);
                if (value && !ok) {
                  toast.push({ variant: 'warning', message: 'Notification permission was not granted.' });
                }
              }}
            />
          </Row>

          <Row title="Auto-accept transfers" description="Off by default. Accept incoming files without asking.">
            <Toggle
              label="Auto-accept incoming transfers"
              checked={settings.autoAccept}
              onChange={(value) => update({ autoAccept: value })}
            />
          </Row>

          <Row
            title="Auto-download received files"
            description="A single received file is saved automatically when the transfer finishes."
          >
            <Toggle
              label="Auto-download received files"
              checked={settings.autoDownload}
              onChange={(value) => update({ autoDownload: value })}
            />
          </Row>
        </section>

        <section className="py-3">
          <p className="label flex items-center gap-2">
            <Download size={13} aria-hidden="true" /> Download behaviour
          </p>
          <div className="flex flex-col gap-2">
            {(
              [
                { value: 'downloads', label: 'Save to browser downloads', hint: 'Works in every browser.' },
                {
                  value: 'folder',
                  label: receiveFolderName ? `Save to “${receiveFolderName}”` : 'Save to a chosen folder',
                  hint: supportsFileSystemAccess()
                    ? 'Chromium browsers only — files stream straight to disk as they arrive.'
                    : 'Not available in this browser; downloads will be used instead.',
                },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={async () => {
                  if (option.value === 'folder') {
                    await chooseReceiveFolder();
                    return;
                  }
                  setSaveBehavior('downloads');
                }}
                aria-pressed={settings.saveBehavior === option.value}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3 text-left transition',
                  settings.saveBehavior === option.value
                    ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
                    : 'border-border hover:border-[color:var(--border-strong)]',
                )}
              >
                <FolderOpen size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium text-text">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-muted">{option.hint}</span>
                </span>
              </button>
            ))}
            {receiveFolderName && (
              <button type="button" className="btn btn-ghost self-start px-2 text-xs" onClick={() => void forgetReceiveFolder()}>
                Forget saved folder
              </button>
            )}
          </div>
        </section>

        <section className="py-1">
          <Row
            title="Transfer history"
            description={`${history.length} recent ${history.length === 1 ? 'entry' : 'entries'} stored locally (metadata only).`}
          >
            <Toggle
              label="Keep transfer history"
              checked={settings.keepHistory}
              onChange={(value) => update({ keepHistory: value })}
            />
          </Row>
        </section>

        <section className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-secondary px-3 text-xs" onClick={() => void wipeHistory()}>
              <Trash2 size={14} />
              Clear history
            </button>
            <button
              type="button"
              className="btn btn-secondary px-3 text-xs"
              onClick={() => {
                resetOnboarding();
                toast.push({ variant: 'info', message: 'The welcome screen will show again on your next visit.' });
              }}
            >
              <RotateCcw size={14} />
              Reset intro
            </button>
            <button
              type="button"
              className="btn btn-danger px-3 text-xs"
              onClick={async () => {
                await wipeLocalData();
                toast.push({ variant: 'info', message: 'Local data cleared', detail: 'Reload the page to start from defaults.' });
              }}
            >
              <Trash2 size={14} />
              Clear all local data
            </button>
          </div>
        </section>

        <section className="py-3">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left"
            onClick={() => setShowPrivacy((value) => !value)}
            aria-expanded={showPrivacy}
          >
            <span className="label mb-0 flex items-center gap-2">
              <ShieldCheck size={13} aria-hidden="true" /> Privacy
            </span>
            <span className="text-xs text-muted">{showPrivacy ? 'Hide' : 'Show'}</span>
          </button>
          {showPrivacy && (
            <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted">
              <p>
                {APP_NAME} is designed to transfer files directly between supported peer devices using WebRTC. When a
                direct connection can be established, file data does not pass through any server.
              </p>
              <p>
                A signaling service coordinates discovery and connection setup. It receives only small connection
                messages (device names, session ids and WebRTC negotiation data) and never file contents. It does not
                store transferred files.
              </p>
              <p>
                Your browser and network configuration can affect how WebRTC establishes a connection. Files received in
                memory are released when you dismiss the transfer; nothing is uploaded anywhere.
              </p>
              {config.signalingMode === 'missing' && (
                <p className="text-[color:var(--warning)]">
                  No signaling server is configured for this deployment, so device discovery is currently unavailable.
                </p>
              )}
            </div>
          )}
        </section>

        <section className="pt-3">
          <p className="label flex items-center gap-2">
            <Info size={13} aria-hidden="true" /> About
          </p>
          <div className="space-y-1.5 text-xs leading-relaxed text-muted">
            <p className="text-sm font-semibold text-text">
              {APP_NAME} <span className="font-normal text-muted">v{APP_VERSION}</span>
            </p>
            <p>{TAGLINE}</p>
            <p>
              Built by{' '}
              <a
                className="font-medium text-accent underline-offset-2 hover:underline"
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {CREATOR}
              </a>
              .
            </p>
            <p>
              Room: <span className="font-mono text-text">{roomId ?? '—'}</span>
            </p>
            <p className="flex items-center gap-2 pt-1">
              <Bell size={12} aria-hidden="true" />
              Notification permission is only requested when you switch notifications on.
            </p>
          </div>
        </section>
      </div>
    </Modal>
  );
}
