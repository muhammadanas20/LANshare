import { ArrowDown, ArrowUp, Image as ImageIcon, Trash2 } from 'lucide-react';
import type { QueuedFile } from '../types/transfer';
import { formatBytes, formatClock } from '../utils/format';
import { fileTypeLabel } from '../utils/fileKind';
import { FileTypeIcon } from './FileTypeIcon';

interface FileCardProps {
  item: QueuedFile;
  onRemove: (id: string) => void;
  onMove?: (id: string, direction: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  index: number;
}

/** Compact, information-dense row: preview, name, type, size, duration. */
export function FileCard({ item, onRemove, onMove, canMoveUp, canMoveDown, index }: FileCardProps) {
  const hasImagePreview = Boolean(item.previewUrl && item.mime.startsWith('image/'));

  return (
    <li className="file-tile flex items-center gap-3 p-2.5 animate-fade-in-up">
      <div className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
        {item.previewUrl && (hasImagePreview || item.mime.startsWith('video/')) ? (
          <img
            src={item.previewUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <FileTypeIcon mime={item.mime} name={item.name} size={22} />
        )}
        {item.previewUrl && item.mime.startsWith('video/') && !hasImagePreview && (
          <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 text-[10px] font-medium text-white">
            ▶
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text" title={item.relPath ?? item.name}>
          {item.name}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span>{fileTypeLabel(item.mime, item.name)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(item.size)}</span>
          {item.durationSeconds ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatClock(item.durationSeconds)}</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {onMove && (
          <div className="hidden sm:flex">
            <button
              type="button"
              className="icon-btn h-9 w-9"
              onClick={() => onMove(item.id, -1)}
              disabled={!canMoveUp}
              aria-label={`Move ${item.name} earlier in the queue (position ${index + 1})`}
            >
              <ArrowUp size={15} />
            </button>
            <button
              type="button"
              className="icon-btn h-9 w-9"
              onClick={() => onMove(item.id, 1)}
              disabled={!canMoveDown}
              aria-label={`Move ${item.name} later in the queue (position ${index + 1})`}
            >
              <ArrowDown size={15} />
            </button>
          </div>
        )}
        <button
          type="button"
          className="icon-btn h-9 w-9 hover:text-[color:var(--danger)]"
          onClick={() => onRemove(item.id)}
          aria-label={`Remove ${item.name} from the queue`}
        >
          <Trash2 size={16} />
        </button>
      </div>

      {hasImagePreview && <ImageIcon className="hidden" aria-hidden="true" />}
    </li>
  );
}
