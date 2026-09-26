import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, DoorOpen, Download, Link2, Loader2, Plus, QrCode as QrIcon, Smartphone, WifiOff } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { useToast } from '../state/toast';
import { copyText } from '../utils/clipboard';
import { Modal } from './Modal';

/**
 * Pairing helper: a QR code plus a short room code so a phone can jump straight into
 * the same room (spec §26). Nothing here contains file data or device identifiers.
 */
export function QRModal({
  open,
  onClose,
  onOpenServerless,
}: {
  open: boolean;
  onClose: () => void;
  onOpenServerless?: (() => void) | undefined;
}) {
  const { roomId, createPrivateRoom, joinDefaultRoom, signalingState, offlineLan } = useLanShare();
  const toast = useToast();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lanDataUrl, setLanDataUrl] = useState<string | null>(null);
  const [singleFileAvailable, setSingleFileAvailable] = useState(false);

  // Offline host: the address that matters is the LAN address the *other* device must open
  // (the current origin may be `localhost`, which is meaningless on a phone).
  const offlineUrls = offlineLan?.urls ?? [];
  const lanUrl = useMemo(() => {
    if (offlineUrls.length === 0) return '';
    return roomId ? `${offlineUrls[0]}?room=${encodeURIComponent(roomId)}` : offlineUrls[0];
  }, [offlineUrls, roomId]);

  const joinUrl = useMemo(() => {
    if (!roomId || typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    url.hash = '';
    return url.toString();
  }, [roomId]);

  // Does this host offer the single-file app? Only offered when it actually exists, so the
  // download link is never a dead end.
  useEffect(() => {
    if (!open || !offlineLan) return;
    let cancelled = false;
    fetch('/single-file.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { available: false }))
      .then((payload: { available?: boolean }) => {
        if (!cancelled) setSingleFileAvailable(Boolean(payload.available));
      })
      .catch(() => {
        if (!cancelled) setSingleFileAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, offlineLan]);

  useEffect(() => {
    if (!open || !lanUrl) {
      setLanDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(lanUrl, { errorCorrectionLevel: 'M', margin: 1, width: 384, color: { dark: '#0e1626ff', light: '#ffffffff' } })
      .then((url) => {
        if (!cancelled) setLanDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setLanDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, lanUrl]);

  useEffect(() => {
    if (!open || !joinUrl) return;
    let cancelled = false;
    setFailed(false);
    QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
      color: { dark: '#0e1626ff', light: '#ffffffff' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, joinUrl]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Pair another device"
      description="Scan the code, or send the room link, so both devices join the same room."
      variant="sheet"
      size="md"
    >
      <div className="flex flex-col items-center gap-4">
        {offlineLan && (
          <div className="surface-muted w-full space-y-3 p-3">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              <WifiOff size={13} aria-hidden="true" />
              Offline LAN mode — no internet needed
            </p>
            <div className="flex items-start gap-3">
              {lanDataUrl ? (
                <img
                  src={lanDataUrl}
                  width={132}
                  height={132}
                  alt="QR code that opens this LANShare host on another device"
                  className="h-33 w-33 shrink-0 rounded-lg border border-border bg-white p-1"
                  style={{ width: 132, height: 132 }}
                />
              ) : (
                <div className="grid h-33 w-33 shrink-0 place-items-center rounded-lg border border-border bg-white text-muted" style={{ width: 132, height: 132 }}>
                  <Smartphone size={20} aria-hidden="true" />
                </div>
              )}
              <div className="min-w-0 space-y-2">
                <p className="text-xs leading-relaxed text-muted">
                  On the other device, connect to the same network (or this device's hotspot) and scan this — or open
                  the address.
                  {singleFileAvailable
                    ? ' "Save the app for later" gives that device a copy that keeps working when this computer is off.'
                    : ''}
                </p>
                <p className="truncate font-mono text-xs text-text" title={lanUrl}>
                  {offlineUrls[0] ?? 'address unavailable'}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary px-3 text-xs"
                    disabled={!lanUrl}
                    onClick={async () => {
                      const ok = await copyText(lanUrl);
                      toast.push({ variant: ok ? 'success' : 'error', message: ok ? 'LAN link copied' : 'Could not copy' });
                    }}
                  >
                    <Copy size={14} />
                    Copy LAN link
                  </button>
                  {singleFileAvailable && (
                    <a
                      className="btn btn-secondary px-3 text-xs"
                      href="/LANShare.html"
                      download="LANShare.html"
                      title="A single file that works on that device later, even with no server running"
                    >
                      <Download size={14} />
                      Save the app for later
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-white p-3 shadow-soft">
          {dataUrl ? (
            <img
              src={dataUrl}
              width={208}
              height={208}
              alt={`QR code that opens LANShare in room ${roomId ?? ''}`}
              className="h-52 w-52"
            />
          ) : (
            <div className="grid h-52 w-52 place-items-center text-muted">
              {failed ? (
                <span className="px-4 text-center text-xs">QR generation failed — use the room code below.</span>
              ) : (
                <Loader2 size={22} className="animate-spin" aria-hidden="true" />
              )}
            </div>
          )}
        </div>

        <div className="w-full space-y-3">
          <div className="surface-muted flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Room code</p>
              <p className="mt-0.5 font-mono text-lg tracking-[0.2em] text-text">{roomId ?? 'connecting…'}</p>
            </div>
            <button
              type="button"
              className="btn btn-secondary px-3 text-xs"
              disabled={!roomId}
              onClick={async () => {
                if (!roomId) return;
                const ok = await copyText(roomId);
                toast.push({ variant: ok ? 'success' : 'error', message: ok ? 'Room code copied' : 'Could not copy' });
              }}
            >
              <Copy size={14} />
              Copy
            </button>
          </div>

          <div className="surface-muted flex items-center gap-3 p-3">
            <Link2 size={16} className="shrink-0 text-muted" aria-hidden="true" />
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={joinUrl}>
              {joinUrl || 'Available once connected'}
            </p>
            <button
              type="button"
              className="btn btn-secondary px-3 text-xs"
              disabled={!joinUrl}
              onClick={async () => {
                const ok = await copyText(joinUrl);
                toast.push({ variant: ok ? 'success' : 'error', message: ok ? 'Room link copied' : 'Could not copy' });
              }}
            >
              <Copy size={14} />
              Copy link
            </button>
          </div>

          {onOpenServerless && (
            <button
              type="button"
              className="btn btn-secondary w-full text-xs"
              onClick={() => {
                onClose();
                onOpenServerless();
              }}
            >
              <QrIcon size={14} />
              No server available? Pair with a code instead
            </button>
          )}

          <div className="flex flex-col gap-2 xs:flex-row">
            <button type="button" className="btn btn-primary flex-1" onClick={createPrivateRoom}>
              <Plus size={16} />
              New private room
            </button>
            <button type="button" className="btn btn-secondary flex-1" onClick={joinDefaultRoom}>
              <DoorOpen size={16} />
              Nearby room
            </button>
          </div>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
            <QrIcon size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            Rooms are temporary. A room disappears as soon as the last device leaves, and no file data is ever stored on
            the connection service.
            {signalingState !== 'connected' && ' You appear to be offline — reconnect to share the code.'}
          </p>
        </div>
      </div>
    </Modal>
  );
}
