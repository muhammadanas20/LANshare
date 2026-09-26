import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { APP_NAME } from './config';
import { useLanShare } from './state/lanshare';
import { useSettings } from './state/settings';
import { useToast } from './state/toast';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { checkBrowserCapabilities } from './utils/device';
import { filesFromPasteEvent } from './utils/clipboard';
import { Header } from './components/Header';
import { ConnectionBanner } from './components/ConnectionBanner';
import { SharePanel } from './components/SharePanel';
import { DeviceList } from './components/DeviceList';
import { TransferList } from './components/TransferList';
import { HistoryList } from './components/HistoryList';
import { Footer } from './components/Footer';
import { ToastViewport } from './components/ToastViewport';
import { LoadingScreen } from './components/LoadingScreen';
import { Onboarding } from './components/Onboarding';
import { SendDialog } from './components/SendDialog';
import { DeviceSheet } from './components/DeviceSheet';
import { IncomingDialog } from './components/IncomingDialog';
import { QRModal } from './components/QRModal';
import { ServerlessPairingModal } from './components/ServerlessPairingModal';
import { SettingsSheet } from './components/SettingsSheet';
import { UnsupportedScreen } from './components/UnsupportedScreen';
import { requestPersistentStorage } from './services/file';
import { collectSharedFiles, onSharedPayload } from './services/shareTarget';

export default function App() {
  const capabilities = useRef(checkBrowserCapabilities()).current;
  const {
    signalingState,
    peers,
    addFiles,
    queue,
    textDraft,
    selfId,
    retrySignaling,
    activeCount,
    setTextDraft,
  } = useLanShare();
  const { settings, completeOnboarding } = useSettings();
  const toast = useToast();
  const { canInstall, promptInstall } = useInstallPrompt();

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'files' | 'text'>('files');
  const [dragActive, setDragActive] = useState(false);
  const [sendMode, setSendMode] = useState<'files' | 'text' | null>(null);
  const [deviceSheet, setDeviceSheet] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [serverlessOpen, setServerlessOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);

  /* ---------------- boot: hide the loading screen once we know the state ---------------- */
  useEffect(() => {
    const started = performance.now();
    const ready = signalingState === 'connected' || signalingState === 'error';
    if (!ready) return;
    const elapsed = performance.now() - started;
    const timer = setTimeout(() => setLoading(false), Math.max(0, 600 - elapsed));
    return () => clearTimeout(timer);
  }, [signalingState]);

  useEffect(() => {
    if (signalingState !== 'error') return;
    // Never leave the user staring at a spinner if the service is unreachable.
    const timer = setTimeout(() => setLoading(false), 1200);
    return () => clearTimeout(timer);
  }, [signalingState]);

  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  /* ---------------- file pickers ---------------- */
  const handleFiles = useCallback(
    async (files: FileList | File[] | null, source: string) => {
      const { added, issues } = await addFiles(files);
      if (added > 0) {
        setTab('files');
        toast.push({
          variant: 'success',
          message: `Added ${added} ${added === 1 ? 'file' : 'files'} to the queue`,
          ...(source ? { detail: source } : {}),
        });
      }
      issues.forEach((issue) => {
        toast.push({ variant: 'warning', message: `${issue.name}: ${issue.reason}`, durationMs: 6000 });
      });
    },
    [addFiles, toast],
  );

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  const openFolderPicker = useCallback(() => folderInputRef.current?.click(), []);

  /* ---------------- incoming files from the OS share sheet (installed PWA) ---------------- */
  useEffect(() => {
    let cancelled = false;

    const consumeShared = async () => {
      const { files, text } = await collectSharedFiles();
      if (cancelled) return;
      if (files.length > 0) {
        await handleFiles(files, 'Shared from your device');
      }
      if (text && text.trim() && files.length === 0) {
        setTextDraft(text);
        setTab('text');
        toast.push({ variant: 'info', message: 'Shared text added to the Text tab' });
      }
      if (files.length === 0 && !text) return;
      const url = new URL(window.location.href);
      url.searchParams.delete('share');
      url.searchParams.delete('share-error');
      window.history.replaceState({}, '', url.toString());
    };

    if (new URLSearchParams(window.location.search).get('share-error') === '1') {
      toast.push({
        variant: 'warning',
        message: 'The shared item could not be read',
        detail: 'Try sharing it again from your device.',
      });
      const url = new URL(window.location.href);
      url.searchParams.delete('share-error');
      window.history.replaceState({}, '', url.toString());
    } else if (new URLSearchParams(window.location.search).get('share') === '1') {
      void consumeShared();
    }

    const unsubscribe = onSharedPayload(() => {
      void consumeShared();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [handleFiles, setTextDraft, toast]);

  /* ---------------- whole-window drag & drop ---------------- */
  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounter.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const files = event.dataTransfer.files;
      if (files && files.length > 0) void handleFiles(files, 'Dropped onto the window');
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles]);

  /* ---------------- clipboard paste (text, links, screenshots) ---------------- */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
      const { files, text } = filesFromPasteEvent(event);

      if (files.length > 0) {
        event.preventDefault();
        void handleFiles(files, 'Pasted from the clipboard');
        return;
      }
      if (isEditable) return; // let the user paste into the text box normally
      if (text && text.trim().length > 0) {
        event.preventDefault();
        setTab('text');
        setTextDraft(text);
        toast.push({
          variant: 'info',
          message: 'Pasted text into the Text tab',
          detail: 'Review it, then pick a device to send.',
        });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles, setTextDraft, toast]);

  /* ---------------- status summary ---------------- */
  const statusTone: 'ok' | 'warn' | 'error' =
    signalingState === 'connected' ? 'ok' : signalingState === 'error' ? 'error' : 'warn';
  const statusLabel =
    signalingState === 'connected'
      ? peers.some((peer) => peer.status === 'connected')
        ? `${peers.filter((peer) => peer.status === 'connected').length} connected`
        : 'Ready to receive'
      : signalingState === 'error'
        ? 'Offline'
        : signalingState === 'reconnecting'
          ? 'Reconnecting…'
          : 'Connecting…';

  if (!capabilities.ok) {
    return <UnsupportedScreen missing={capabilities.missing} />;
  }

  return (
    <div className="min-h-dvh">
      <LoadingScreen status={loading ? 'connecting' : 'ready'} />

      <Header
        statusLabel={statusLabel}
        statusTone={statusTone}
        onOpenQr={() => setQrOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onInstall={() => void promptInstall()}
        canInstall={canInstall}
      />

      {/* The boot overlay is the visible main content until it fades: keep the shell out of
          the accessibility tree meanwhile so it is not a duplicate `main` landmark. */}
      <main
        className="mx-auto w-full max-w-5xl space-y-5 px-4 pb-10 pt-5"
        aria-hidden={loading ? true : undefined}
      >
        <section className="text-center sm:text-left">
          <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            Share anything nearby
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            <span className="font-medium text-text">{settings.displayName || 'This device'}</span>
            <span className="mx-1.5" aria-hidden="true">
              ·
            </span>
            {selfId ? `session ${selfId}` : 'connecting…'}
            {activeCount > 0 && (
              <>
                <span className="mx-1.5" aria-hidden="true">
                  ·
                </span>
                {activeCount} active {activeCount === 1 ? 'transfer' : 'transfers'}
              </>
            )}
          </p>
        </section>

        <ConnectionBanner onOpenServerlessPairing={() => setServerlessOpen(true)} />

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
          <div className="space-y-5">
            <SharePanel
              dragActive={dragActive}
              onBrowse={openFilePicker}
              onPickFolder={openFolderPicker}
              tab={tab}
              onTabChange={setTab}
              onRequestSendFiles={() => setSendMode('files')}
              onRequestSendText={() => setSendMode('text')}
            />
            <TransferList />
          </div>

          <div className="space-y-5">
            <DeviceList
              peers={peers}
              onOpenDevice={setDeviceSheet}
              onQuickSend={(peerId) => {
                setDeviceSheet(null);
                if (queue.length > 0) {
                  setSendMode('files');
                } else if (textDraft.trim()) {
                  setSendMode('text');
                } else {
                  setDeviceSheet(peerId);
                }
              }}
              onShowQr={() => setQrOpen(true)}
              onRetry={retrySignaling}
              signalingBusy={signalingState === 'connecting' || signalingState === 'reconnecting'}
              quickSendLabel={queue.length > 0 ? 'Send' : 'Open'}
            />
            <HistoryList />
          </div>
        </div>

        <Footer onOpenAbout={() => setSettingsOpen(true)} />
      </main>

      {/* Drag & drop overlay (window-wide drop is the actual target) */}
      {dragActive && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-6">
          <div className="surface flex items-center gap-3 border-[color:var(--accent)] px-6 py-4 shadow-glow animate-scale-in">
            <Upload size={22} className="text-accent" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-text">Drop to share</p>
              <p className="text-xs text-muted">Release anywhere on this page</p>
            </div>
          </div>
        </div>
      )}

      {/* Hidden inputs: arbitrary file types, and folder selection where supported */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files, 'Selected from your device');
          event.target.value = '';
        }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // eslint-disable-next-line react/no-unknown-property
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        className="hidden"
        onChange={(event) => {
          void handleFiles(event.target.files, 'Selected from a folder');
          event.target.value = '';
        }}
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Dialogs */}
      <SendDialog open={sendMode !== null} onClose={() => setSendMode(null)} mode={sendMode ?? 'files'} />
      <DeviceSheet
        peerId={deviceSheet}
        onClose={() => setDeviceSheet(null)}
        onSendFiles={() => {
          setSendMode('files');
          setDeviceSheet(null);
        }}
        onSendText={() => {
          setSendMode('text');
          setDeviceSheet(null);
        }}
      />
      <IncomingDialog />
      <QRModal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        onOpenServerless={() => setServerlessOpen(true)}
      />
      <ServerlessPairingModal open={serverlessOpen} onClose={() => setServerlessOpen(false)} />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Onboarding
        open={!settings.seenOnboarding && !loading}
        onClose={() => completeOnboarding()}
      />

      <ToastViewport />

      <span className="sr-only" role="status" aria-live="polite">
        {`${APP_NAME} ${statusLabel}. ${peers.length} nearby devices.`}
      </span>
    </div>
  );
}
