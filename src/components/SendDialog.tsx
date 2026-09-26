import { useMemo } from 'react';
import { File, MessageSquare, Send, Smartphone } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { formatBytes } from '../utils/format';
import { Modal } from './Modal';
import { statusLabel } from './DeviceCard';
import { cn } from '../utils/cn';
import { deviceKindLabel } from '../utils/device';

/**
 * Target picker shown when sending a file queue or a text snippet.
 * Only devices that currently hold an open data channel can receive.
 */
export function SendDialog({
  open,
  onClose,
  mode,
}: {
  open: boolean;
  onClose: () => void;
  mode: 'files' | 'text';
}) {
  const { peers, queue, sendQueueTo, sendTextTo, connectTo, textDraft } = useLanShare();

  const totalBytes = useMemo(() => queue.reduce((sum, item) => sum + item.size, 0), [queue]);
  const connectedPeers = peers.filter((peer) => peer.status === 'connected');
  const others = peers.filter((peer) => peer.status !== 'connected');

  const handlePick = (peerId: string, connected: boolean) => {
    if (!connected) {
      connectTo(peerId);
      return;
    }
    const ok = mode === 'files' ? sendQueueTo(peerId) : sendTextTo(peerId);
    if (ok) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'files' ? 'Send files to…' : 'Send text to…'}
      description={
        mode === 'files'
          ? `${queue.length} ${queue.length === 1 ? 'file' : 'files'} · ${formatBytes(totalBytes)} — the other device must accept first.`
          : `${textDraft.trim().length.toLocaleString()} characters — the other device must accept first.`
      }
      variant="sheet"
      size="md"
    >
      {peers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <Smartphone size={22} className="text-muted" aria-hidden="true" />
          <p className="text-sm font-medium text-text">No devices available yet</p>
          <p className="max-w-xs text-xs text-muted">
            Open LANShare on the other device — it will show up here within a second or two.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {connectedPeers.length > 0 && (
            <div>
              <p className="label">Ready to receive</p>
              <ul className="space-y-2">
                {connectedPeers.map((peer) => (
                  <li key={peer.id}>
                    <button
                      type="button"
                      className="w-full file-tile flex items-center justify-between gap-3 p-3 text-left transition hover:border-[color:var(--accent)]"
                      onClick={() => handlePick(peer.id, true)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">{peer.name}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                          <span className="status-dot" data-status="connected" aria-hidden="true" />
                          {deviceKindLabel(peer.device)} · {statusLabel(peer.status)}
                        </span>
                      </span>
                      <span className="btn btn-primary pointer-events-none px-3 text-xs">
                        {mode === 'files' ? <File size={14} /> : <MessageSquare size={14} />}
                        Send
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {others.length > 0 && (
            <div>
              <p className="label">Other devices</p>
              <ul className="space-y-2">
                {others.map((peer) => (
                  <li key={peer.id}>
                    <button
                      type="button"
                      className={cn(
                        'w-full flex items-center justify-between gap-3 rounded-xl border border-border bg-[color:var(--surface-secondary)] p-3 text-left',
                        'transition hover:border-[color:var(--border-strong)]',
                      )}
                      onClick={() => handlePick(peer.id, false)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-text">{peer.name}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                          <span className="status-dot" data-status={peer.status} aria-hidden="true" />
                          {statusLabel(peer.status)}
                        </span>
                      </span>
                      <span className="btn btn-secondary pointer-events-none px-3 text-xs">
                        <Send size={14} />
                        Connect
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
