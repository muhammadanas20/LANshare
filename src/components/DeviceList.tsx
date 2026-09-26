import { QrCode, RefreshCw, WifiOff } from 'lucide-react';
import type { Peer } from '../types/peer';
import { DeviceCard } from './DeviceCard';

interface DeviceListProps {
  peers: Peer[];
  onOpenDevice: (peerId: string) => void;
  onQuickSend: (peerId: string) => void;
  onShowQr: () => void;
  onRetry: () => void;
  signalingBusy: boolean;
  quickSendLabel?: string;
}

export function DeviceList({
  peers,
  onOpenDevice,
  onQuickSend,
  onShowQr,
  onRetry,
  signalingBusy,
  quickSendLabel = 'Send',
}: DeviceListProps) {
  return (
    <section className="surface p-4 sm:p-5" aria-labelledby="nearby-heading">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 id="nearby-heading" className="text-sm font-semibold text-text">
            Nearby devices
          </h2>
          {peers.length > 0 && (
            <span className="chip" aria-label={`${peers.length} devices`}>
              {peers.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="icon-btn"
            onClick={onRetry}
            aria-label="Refresh nearby devices"
            title="Refresh"
          >
            <RefreshCw size={16} className={signalingBusy ? 'animate-spin' : undefined} />
          </button>
          <button type="button" className="btn btn-ghost px-3 text-xs" onClick={onShowQr}>
            <QrCode size={15} />
            Share
          </button>
        </div>
      </div>

      {peers.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[color:var(--border-strong)] px-4 py-8 text-center">
          <WifiOff size={22} className="text-muted" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-text">No devices nearby</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
              Open {''}
              <span className="font-medium text-text">LANShare</span> on another device connected to the same network.
              Both devices need to reach the same connection service.
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onShowQr}>
            <QrCode size={16} />
            Show QR code
          </button>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {peers.map((peer, index) => (
            <DeviceCard
              key={peer.id}
              peer={peer}
              index={index}
              onOpen={onOpenDevice}
              onQuickSend={onQuickSend}
              quickSendLabel={quickSendLabel}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
