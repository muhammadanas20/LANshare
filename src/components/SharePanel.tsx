import { useRef, type KeyboardEvent } from 'react';
import { FileUp, MessageSquareText } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { supportsFileSystemAccess } from '../utils/device';
import { cn } from '../utils/cn';
import { DropZone } from './DropZone';
import { FileQueue } from './FileQueue';
import { TextShare } from './TextShare';

export type ShareTab = 'files' | 'text';

interface SharePanelProps {
  tab: ShareTab;
  onTabChange: (tab: ShareTab) => void;
  dragActive: boolean;
  onBrowse: () => void;
  onPickFolder: () => void;
  onRequestSendFiles: () => void;
  onRequestSendText: () => void;
}

/** The primary surface: choose files or text, then send. */
export function SharePanel({
  tab,
  onTabChange,
  dragActive,
  onBrowse,
  onPickFolder,
  onRequestSendFiles,
  onRequestSendText,
}: SharePanelProps) {
  const { queue, removeFile, moveFile, clearQueue, textDraft, setTextDraft, peers } = useLanShare();
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const hasConnectedPeer = peers.some((peer) => peer.status === 'connected');

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next: ShareTab = tab === 'files' ? 'text' : 'files';
    onTabChange(next);
    const button = tabsRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`);
    button?.focus();
  };

  return (
    <section aria-label="Share" className="space-y-3">
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Share mode"
        className="surface inline-flex items-center gap-1 p-1"
        onKeyDown={onTabKeyDown}
      >
        {(
          [
            { id: 'files' as const, label: 'Files', icon: FileUp },
            { id: 'text' as const, label: 'Text', icon: MessageSquareText },
          ] satisfies Array<{ id: ShareTab; label: string; icon: typeof FileUp }>
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-tab={id}
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => onTabChange(id)}
            className={cn(
              'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition',
              tab === id
                ? 'bg-[color:var(--accent)] text-[color:var(--accent-contrast)]'
                : 'text-muted hover:text-text',
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <div id={`panel-files`} role="tabpanel" aria-labelledby="tab-files" hidden={tab !== 'files'} className="space-y-3">
        {tab === 'files' && (
          <>
            <DropZone
              active={dragActive}
              compact={queue.length > 0}
              onBrowse={onBrowse}
              onPickFolder={onPickFolder}
              folderSupported={supportsFileSystemAccess()}
            />
            <FileQueue
              queue={queue}
              onRemove={removeFile}
              onMove={moveFile}
              onClear={clearQueue}
              onAddMore={onBrowse}
              onSend={onRequestSendFiles}
              canSend={queue.length > 0}
            />
          </>
        )}
      </div>

      <div id={`panel-text`} role="tabpanel" aria-labelledby="tab-text" hidden={tab !== 'text'}>
        {tab === 'text' && (
          <TextShare value={textDraft} onChange={setTextDraft} onSend={onRequestSendText} canSend={textDraft.trim().length > 0} />
        )}
      </div>

      {!hasConnectedPeer && peers.length > 0 && (
        <p className="px-1 text-xs text-muted">
          Tip: tap a device below to connect before sending — the first connection takes a moment.
        </p>
      )}
    </section>
  );
}
