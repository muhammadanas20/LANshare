import { ArrowDownToLine, ArrowUpFromLine, History } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { formatBytes, formatWhen } from '../utils/format';

/** Metadata-only transfer history (never file contents). */
export function HistoryList() {
  const { history, wipeHistory } = useLanShare();
  if (history.length === 0) return null;

  return (
    <section className="surface p-4 sm:p-5" aria-labelledby="history-heading">
      <div className="flex items-center justify-between">
        <h2 id="history-heading" className="flex items-center gap-2 text-sm font-semibold text-text">
          <History size={15} aria-hidden="true" />
          Recent
        </h2>
        <button type="button" className="btn btn-ghost px-3 text-xs" onClick={() => void wipeHistory()}>
          Clear history
        </button>
      </div>

      <ul className="mt-3 space-y-2">
        {history.slice(0, 8).map((entry) => (
          <li key={`${entry.id}-${entry.completedAt}`} className="flex items-center gap-3 py-1">
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-[color:var(--surface-secondary)]"
              aria-hidden="true"
            >
              {entry.direction === 'sending' ? (
                <ArrowUpFromLine size={14} className="text-accent" />
              ) : (
                <ArrowDownToLine size={14} className="text-success" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-text">
                {entry.fileCount === 1 ? entry.fileNames[0] ?? 'File' : `${entry.fileCount} files`}
                <span className="ml-1.5 font-normal text-muted">
                  {entry.status === 'completed' ? '' : `· ${entry.status}`}
                </span>
              </p>
              <p className="text-[11px] text-muted">
                {entry.direction === 'sending' ? 'Sent to' : 'Received from'} {entry.peerName} · {formatWhen(entry.completedAt)} ·{' '}
                {formatBytes(entry.totalSize)}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted">Only file names and sizes are kept — never file data.</p>
    </section>
  );
}
