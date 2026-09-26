import { Plus, Send, Trash2 } from 'lucide-react';
import type { QueuedFile } from '../types/transfer';
import { formatBytes } from '../utils/format';
import { FileCard } from './FileCard';

interface FileQueueProps {
  queue: QueuedFile[];
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onClear: () => void;
  onAddMore: () => void;
  onSend: () => void;
  canSend: boolean;
}

export function FileQueue({ queue, onRemove, onMove, onClear, onAddMore, onSend, canSend }: FileQueueProps) {
  if (queue.length === 0) return null;
  const totalBytes = queue.reduce((sum, item) => sum + item.size, 0);

  return (
    <section className="surface p-4 animate-fade-in sm:p-5" aria-labelledby="file-queue-heading">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="file-queue-heading" className="text-sm font-semibold text-text">
            Selected files
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {queue.length} {queue.length === 1 ? 'file' : 'files'} · {formatBytes(totalBytes)} total
          </p>
        </div>
        <button type="button" className="btn btn-ghost px-3 text-xs" onClick={onClear}>
          <Trash2 size={14} />
          Clear all
        </button>
      </div>

      <ul className="scroll-area mt-3 max-h-[38vh] space-y-2 overflow-y-auto pr-0.5">
        {queue.map((item, index) => (
          <FileCard
            key={item.id}
            item={item}
            index={index}
            onRemove={onRemove}
            onMove={onMove}
            canMoveUp={index > 0}
            canMoveDown={index < queue.length - 1}
          />
        ))}
      </ul>

      <div className="mt-4 flex flex-col gap-2 xs:flex-row xs:items-center xs:justify-between">
        <button type="button" className="btn btn-secondary" onClick={onAddMore}>
          <Plus size={16} />
          Add more
        </button>
        <button type="button" className="btn btn-primary" onClick={onSend} disabled={!canSend}>
          <Send size={16} />
          Send {queue.length === 1 ? 'file' : `${queue.length} files`}
        </button>
      </div>
    </section>
  );
}
