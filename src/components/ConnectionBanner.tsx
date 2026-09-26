import { CloudOff, Loader2, QrCode, RefreshCw, Wifi } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { config } from '../config';

/**
 * Shows the real transport state: browser connectivity, signaling socket and
 * (implicitly) whether peers can be reached. No fake "online" states.
 */
export function ConnectionBanner({ onOpenServerlessPairing }: { onOpenServerlessPairing?: (() => void) | undefined }) {
  const { signalingState, signalingError, retrySignaling, peers } = useLanShare();
  const { online } = useNetworkStatus();

  const connectedPeers = peers.filter((peer) => peer.status === 'connected').length;

  if (!online) {
    return (
      <Banner
        tone="danger"
        icon={<CloudOff size={16} />}
        title="Network unavailable"
        detail="Your device is offline. Reconnect to Wi-Fi to find nearby devices."
      />
    );
  }

  if (config.signalingMode === 'missing') {
    return (
      <Banner
        tone="warning"
        icon={<CloudOff size={16} />}
        title="No connection service configured"
        detail="Devices cannot be discovered automatically here. Pair them directly instead — no server is needed for that."
        action={
          onOpenServerlessPairing ? (
            <button type="button" className="btn btn-primary px-3 text-xs" onClick={onOpenServerlessPairing}>
              <QrCode size={14} />
              Pair without a server
            </button>
          ) : undefined
        }
      />
    );
  }

  if (signalingState === 'error') {
    return (
      <Banner
        tone="danger"
        icon={<CloudOff size={16} />}
        title="Cannot reach the connection service"
        detail={signalingError ?? 'Check your network connection and try again.'}
        action={
          <span className="flex shrink-0 items-center gap-2">
            {onOpenServerlessPairing && (
              <button type="button" className="btn btn-primary px-3 text-xs" onClick={onOpenServerlessPairing}>
                <QrCode size={14} />
                Pair without a server
              </button>
            )}
            <button type="button" className="btn btn-secondary px-3 text-xs" onClick={retrySignaling}>
              <RefreshCw size={14} />
              Retry
            </button>
          </span>
        }
      />
    );
  }

  if (signalingState === 'reconnecting' || signalingState === 'connecting') {
    return (
      <Banner
        tone="warning"
        icon={<Loader2 size={16} className="animate-spin" />}
        title={signalingState === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        detail="Restoring contact with the connection service. Direct transfers already in progress continue."
      />
    );
  }

  if (signalingState === 'connected' && connectedPeers === 0) {
    return (
      <Banner
        tone="neutral"
        icon={<Wifi size={16} />}
        title="Ready to receive"
        detail="Waiting for another device to open LANShare on this network."
      />
    );
  }

  return null;
}

function Banner({
  tone,
  icon,
  title,
  detail,
  action,
}: {
  tone: 'neutral' | 'warning' | 'danger';
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-[color:var(--danger)]/40 bg-[color:var(--danger-soft)] text-[color:var(--danger)]'
      : tone === 'warning'
        ? 'border-[color:var(--warning)]/40 bg-[color:var(--warning-soft)] text-[color:var(--warning)]'
        : 'border-border bg-[color:var(--surface)] text-muted';

  return (
    <div className={`surface flex items-center gap-3 px-3.5 py-2.5 ${toneClass}`} role="status" aria-live="polite">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{title}</p>
        {/* No opacity here: it multiplied the muted tone toward the background and dropped
            the detail text under the 4.5:1 contrast floor. */}
        <p className="mt-0.5 text-xs">{detail}</p>
      </div>
      {action}
    </div>
  );
}
