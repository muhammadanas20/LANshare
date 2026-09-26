import { useRef } from 'react';
import { ClipboardPaste, FolderOpen, Image, Film, Music, FileText, FileArchive } from 'lucide-react';
import { cn } from '../utils/cn';

interface DropZoneProps {
  onBrowse: () => void;
  onPickFolder: () => void;
  folderSupported: boolean;
  active: boolean;
  compact?: boolean;
}

const ACCEPTED_HINTS = [
  { icon: Image, label: 'Photos' },
  { icon: Film, label: 'Videos' },
  { icon: Music, label: 'Audio' },
  { icon: FileText, label: 'Documents' },
  { icon: FileArchive, label: 'Archives' },
];

/**
 * Primary drop target. Purely presentational — the window-level drag handling lives
 * in App so files can be dropped anywhere on the page.
 */
export function DropZone({ onBrowse, onPickFolder, folderSupported, active, compact = false }: DropZoneProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div
      className={cn(
        'drop-surface flex flex-col items-center justify-center gap-4 rounded-2xl px-5 text-center',
        compact ? 'py-7' : 'py-10 sm:py-14',
      )}
      data-active={active ? 'true' : 'false'}
      onDragOver={(event) => event.preventDefault()}
    >
      <div className="flex flex-col items-center gap-1.5">
        <p className="text-base font-semibold tracking-tight text-text sm:text-lg">
          {active ? '✨ Drop to share ✨' : 'Drop files here'}
        </p>
        <p className="text-sm text-muted">
          {active ? 'Release to add them to the transfer' : 'Photos, videos, documents, archives — anything'}
        </p>
      </div>

      <div className="flex flex-col items-center gap-2 xs:flex-row">
        <button ref={buttonRef} type="button" className="btn btn-primary px-5" onClick={onBrowse}>
          Select files
        </button>
        {folderSupported && (
          <button type="button" className="btn btn-secondary px-5" onClick={onPickFolder}>
            <FolderOpen size={16} />
            Select folder
          </button>
        )}
      </div>

      {!compact && (
        <ul className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted">
          {ACCEPTED_HINTS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-1.5">
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted">
        <ClipboardPaste size={13} aria-hidden="true" />
        Tip: paste with <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">Ctrl/⌘ V</kbd>
      </p>
    </div>
  );
}
