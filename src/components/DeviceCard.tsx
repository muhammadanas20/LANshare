import { Laptop, Monitor, Send, Smartphone, Tablet } from 'lucide-react';
import type { Peer } from '../types/peer';
import { cn } from '../utils/cn';
import { initialsOf } from '../utils/randomName';

const ICONS = {
  desktop: Laptop,
  tablet: Tablet,
  mobile: Smartphone,
  unknown: Monitor,
} as const;

export function statusLabel(status: Peer['status']): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'unstable':
      return 'Reconnecting…';
    case 'failed':
      return 'Connection failed';
    case 'offline':
      return 'Offline';
    default:
      return 'Available';
  }
}

interface DeviceCardProps {
  peer: Peer;
  onOpen: (peerId: string) => void;
  onQuickSend?: (peerId: string) => void;
  quickSendLabel?: string;
  index?: number;
}

export function DeviceCard({ peer, onOpen, onQuickSend, quickSendLabel = 'Send', index = 0 }: DeviceCardProps) {
  const Icon = ICONS[peer.device] ?? Monitor;
  const connected = peer.status === 'connected';

  return (
    <li
      className="surface flex items-center gap-3 p-3 transition hover:border-[color:var(--border-strong)] animate-fade-in-up sm:p-3.5"
      style={{ animationDelay: `${Math.min(index * 40, 240)}ms` }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={() => onOpen(peer.id)}
        aria-label={`${peer.name}, ${statusLabel(peer.status)}. Open device options.`}
      >
        <span
          className={cn(
            'relative grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border',
            connected ? 'bg-[color:var(--accent-soft)]' : 'bg-[color:var(--surface-secondary)]',
          )}
          aria-hidden="true"
        >
          <Icon size={19} className={connected ? 'text-[color:var(--accent)]' : 'text-muted'} />
          {connected && (
            <span className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border border-border bg-surface text-[9px] font-bold text-[color:var(--success)]">
              ✓
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text" title={peer.name}>
              {peer.name}
            </span>
            <span className="hidden shrink-0 rounded-full border border-border px-1.5 text-[10px] font-semibold text-muted xs:inline">
              {initialsOf(peer.name)}
            </span>
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
            <span className="status-dot" data-status={peer.status} aria-hidden="true" />
            <span>{statusLabel(peer.status)}</span>
            {peer.rttMs !== undefined && connected && (
              <>
                <span aria-hidden="true">·</span>
                <span>{Math.round(peer.rttMs)} ms</span>
              </>
            )}
          </span>
        </span>
      </button>

      {onQuickSend && (
        <button
          type="button"
          className={cn('btn shrink-0 px-3 text-xs', connected ? 'btn-primary' : 'btn-secondary')}
          onClick={() => onQuickSend(peer.id)}
          aria-label={`${quickSendLabel} to ${peer.name}`}
        >
          <Send size={14} />
          <span className="hidden xs:inline">{quickSendLabel}</span>
        </button>
      )}
    </li>
  );
}
