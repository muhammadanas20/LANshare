import { Link2, MessageSquare, Plug, RefreshCw, Send, ShieldCheck, Unplug } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { deviceKindLabel } from '../utils/device';
import { Modal } from './Modal';
import { statusLabel } from './DeviceCard';

/**
 * Device details + actions. Deliberately avoids exposing IP addresses, fingerprints
 * or any other technical identifier (spec §6).
 */
export function DeviceSheet({
  peerId,
  onClose,
  onSendFiles,
  onSendText,
}: {
  peerId: string | null;
  onClose: () => void;
  onSendFiles: () => void;
  onSendText: () => void;
}) {
  const { peers, queue, connectTo, retryPeer, disconnectPeer } = useLanShare();
  const peer = peers.find((entry) => entry.id === peerId) ?? null;

  if (!peer) return null;
  const connected = peer.status === 'connected';
  const busy = peer.status === 'connecting' || peer.status === 'unstable';

  return (
    <Modal
      open={Boolean(peerId)}
      onClose={onClose}
      title={peer.name}
      description={`${deviceKindLabel(peer.device)} · ${statusLabel(peer.status)}`}
      variant="sheet"
      size="sm"
    >
      <div className="space-y-4">
        <div className="surface-muted flex items-start gap-2.5 p-3 text-xs leading-relaxed text-muted">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[color:var(--success)]" aria-hidden="true" />
          <p>
            File data travels directly between the two devices over an encrypted WebRTC data channel. The connection
            service only helps the devices find each other.
          </p>
        </div>

        <div className="grid gap-2">
          <button
            type="button"
            className="btn btn-primary w-full justify-start"
            onClick={() => {
              onSendFiles();
            }}
            disabled={queue.length === 0}
          >
            <Send size={16} />
            {queue.length === 0 ? 'Send files (queue empty)' : `Send ${queue.length} queued file${queue.length === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="btn btn-secondary w-full justify-start"
            onClick={() => {
              onSendText();
            }}
          >
            <MessageSquare size={16} />
            Send text
          </button>

          {!connected && !busy && (
            <button type="button" className="btn btn-secondary w-full justify-start" onClick={() => connectTo(peer.id)}>
              <Plug size={16} />
              Connect
            </button>
          )}
          {peer.status === 'failed' && (
            <button type="button" className="btn btn-secondary w-full justify-start" onClick={() => retryPeer(peer.id)}>
              <RefreshCw size={16} />
              Retry connection
            </button>
          )}
          {connected && (
            <button
              type="button"
              className="btn btn-danger w-full justify-start"
              onClick={() => {
                disconnectPeer(peer.id);
                onClose();
              }}
            >
              <Unplug size={16} />
              Disconnect
            </button>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div className="surface-muted p-3">
            <dt className="text-muted">Device type</dt>
            <dd className="mt-1 font-medium text-text">{deviceKindLabel(peer.device)}</dd>
          </div>
          <div className="surface-muted p-3">
            <dt className="text-muted">Link</dt>
            <dd className="mt-1 flex items-center gap-1.5 font-medium text-text">
              <Link2 size={13} aria-hidden="true" />
              {connected ? 'Direct (P2P)' : 'Not established'}
            </dd>
          </div>
        </dl>
      </div>
    </Modal>
  );
}
