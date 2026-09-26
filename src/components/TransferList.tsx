import { useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FileDown,
  FolderCheck,
  MessageSquare,
  Package,
  X,
  XCircle,
} from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import type { ReceivedFile, TransferRecord } from '../types/transfer';
import { formatBytes, formatDuration, formatEta, formatSpeed } from '../utils/format';
import { fileTypeLabel } from '../utils/fileKind';
import { downloadBlob, openObjectUrl, readTextPreview } from '../services/file';
import { copyText } from '../utils/clipboard';
import { useToast } from '../state/toast';
import { ProgressBar } from './ProgressBar';
import { FileTypeIcon } from './FileTypeIcon';
import { cn } from '../utils/cn';

function statusTone(status: TransferRecord['status']): string {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'failed':
    case 'rejected':
      return 'text-danger';
    case 'cancelled':
      return 'text-warning';
    default:
      return 'text-accent';
  }
}

function StatusIcon({ status }: { status: TransferRecord['status'] }) {
  if (status === 'completed') return <CheckCircle2 size={16} className="text-success" aria-hidden="true" />;
  if (status === 'failed' || status === 'rejected') return <XCircle size={16} className="text-danger" aria-hidden="true" />;
  if (status === 'cancelled') return <AlertTriangle size={16} className="text-warning" aria-hidden="true" />;
  return null;
}

/** One received file with preview / download / copy actions. */
function ReceivedFileRow({ file }: { file: ReceivedFile }) {
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canPreviewText = Boolean(file.blob) && /^text\/|json|javascript|xml|csv/.test(file.mime);
  const canPreviewImage = Boolean(file.url) && file.mime.startsWith('image/');
  const canPreviewVideo = Boolean(file.url) && file.mime.startsWith('video/');

  return (
    <li className="file-tile p-2.5">
      <div className="flex items-center gap-3">
        <FileTypeIcon mime={file.mime} name={file.name} size={18} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-text" title={file.name}>
            {file.name}
          </p>
          <p className="text-[11px] text-muted">
            {fileTypeLabel(file.mime, file.name)} · {formatBytes(file.size)}
            {file.streamedToDisk ? ' · saved to folder' : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {file.streamedToDisk && <FolderCheck size={16} className="text-success" aria-label="Saved to your folder" />}
          {file.blob && (
            <>
              {(canPreviewImage || canPreviewVideo) && file.url && (
                <button
                  type="button"
                  className="icon-btn h-9 w-9"
                  onClick={() => openObjectUrl(file.url as string)}
                  aria-label={`Preview ${file.name}`}
                  title="Open preview"
                >
                  <Eye size={15} />
                </button>
              )}
              {canPreviewText && (
                <button
                  type="button"
                  className="icon-btn h-9 w-9"
                  onClick={async () => {
                    if (textPreview) {
                      setTextPreview(null);
                      return;
                    }
                    setBusy(true);
                    try {
                      setTextPreview(await readTextPreview(file.blob as Blob, 64 * 1024));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  aria-label={textPreview ? `Hide preview of ${file.name}` : `Show preview of ${file.name}`}
                  title="Show text preview"
                >
                  <MessageSquare size={15} />
                </button>
              )}
              <button
                type="button"
                className="icon-btn h-9 w-9"
                disabled={busy}
                onClick={() => file.blob && downloadBlob(file.blob, file.name)}
                aria-label={`Download ${file.name}`}
                title="Download"
              >
                <FileDown size={15} />
              </button>
            </>
          )}
        </div>
      </div>
      {textPreview !== null && (
        <pre className="scroll-area mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-[color:var(--surface)] p-2 font-mono text-[11px] text-text">
          {textPreview}
        </pre>
      )}
    </li>
  );
}

/** Received text with copy + save actions and no automatic navigation. */
function ReceivedTextView({ record }: { record: TransferRecord }) {
  const toast = useToast();
  const text = record.text ?? '';
  return (
    <div className="surface-muted mt-2 p-3">
      <pre className="scroll-area max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text">
        {text}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary px-3 text-xs"
          onClick={async () => {
            const ok = await copyText(text);
            toast.push({ variant: ok ? 'success' : 'error', message: ok ? 'Text copied' : 'Could not copy the text' });
          }}
        >
          <Copy size={14} />
          Copy
        </button>
        <button
          type="button"
          className="btn btn-ghost px-3 text-xs"
          onClick={() => {
            downloadBlob(new Blob([text], { type: 'text/plain' }), 'lanshare-text.txt');
          }}
        >
          <Download size={14} />
          Save as .txt
        </button>
      </div>
    </div>
  );
}

function TransferRow({ record }: { record: TransferRecord }) {
  const { cancelTransfer, dismissTransfer, downloadAll } = useLanShare();
  const [showText, setShowText] = useState(false);
  const isSending = record.direction === 'sending';
  const active = record.status === 'active' || record.status === 'requesting';
  const ratio = record.totalSize > 0 ? Math.min(1, record.totalBytes / record.totalSize) : 0;
  const currentItem = record.items[record.currentFileIndex];

  const title =
    record.status === 'requesting'
      ? `Waiting for ${record.peerName} to accept…`
      : record.status === 'completed'
        ? isSending
          ? `Sent to ${record.peerName}`
          : `Received from ${record.peerName}`
        : isSending
          ? `Sending to ${record.peerName}`
          : `Receiving from ${record.peerName}`;
  const elapsedSeconds =
    record.endedAt !== undefined ? Math.max(0, (record.endedAt - record.startedAt) / 1000) : null;

  return (
    <li className="surface p-3.5 animate-fade-in-up sm:p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-[color:var(--surface-secondary)]">
          {isSending ? (
            <ArrowUpFromLine size={16} className="text-accent" aria-hidden="true" />
          ) : (
            <ArrowDownToLine size={16} className="text-success" aria-hidden="true" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-text">
                <StatusIcon status={record.status} />
                <span className="truncate">{title}</span>
              </p>
              {record.kind === 'files' && (
                <p className="mt-0.5 truncate text-xs text-muted">
                  {record.items.length > 1
                    ? `${Math.min(record.currentFileIndex + 1, record.items.length)} of ${record.items.length} · ${currentItem?.name ?? ''}`
                    : currentItem?.name ?? ''}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {active && (
                <button
                  type="button"
                  className="btn btn-ghost px-2.5 text-xs hover:text-[color:var(--danger)]"
                  onClick={() => cancelTransfer(record.id)}
                >
                  <X size={14} />
                  Cancel
                </button>
              )}
              {!active && (
                <button
                  type="button"
                  className="icon-btn h-9 w-9"
                  onClick={() => dismissTransfer(record.id)}
                  aria-label="Dismiss this transfer"
                  title="Dismiss"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>

          {active && (
            <div className="mt-2.5 space-y-1.5">
              <ProgressBar
                value={ratio}
                indeterminate={record.status === 'requesting'}
                label={`${title} — ${Math.round(ratio * 100)}%`}
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                <span className={cn('font-semibold', statusTone(record.status))}>{Math.round(ratio * 100)}%</span>
                <span>
                  {formatBytes(record.totalBytes)} / {formatBytes(record.totalSize)}
                </span>
                {record.status === 'active' && <span>{formatSpeed(record.bytesPerSecond)}</span>}
                {record.status === 'active' && <span>ETA: {formatEta(record.etaSeconds)}</span>}
              </div>
            </div>
          )}

          {record.status === 'completed' && (
            <p className="mt-1.5 text-xs text-muted">
              Completed
              {record.kind === 'files' && record.bytesPerSecond > 0
                ? ` · ${formatSpeed(record.bytesPerSecond)} average`
                : ''}
              {elapsedSeconds !== null ? ` · ${formatDuration(elapsedSeconds)}` : ''}
            </p>
          )}

          {record.error && (
            <p className={cn('mt-2 text-xs', statusTone(record.status))} role="status">
              {record.error}
            </p>
          )}

          {record.status === 'completed' && record.kind === 'text' && (
            <div>
              <button type="button" className="btn btn-ghost px-0 text-xs" onClick={() => setShowText((value) => !value)}>
                {showText ? 'Hide text' : 'Show text'}
              </button>
              {showText && <ReceivedTextView record={record} />}
            </div>
          )}

          {record.status === 'completed' && record.kind === 'files' && (
            <div className="mt-2.5 space-y-2">
              {record.received.length > 0 && (
                <>
                  <div className="flex items-center gap-2">
                    <button type="button" className="btn btn-primary px-3 text-xs" onClick={() => void downloadAll(record.id)}>
                      <Package size={14} />
                      {record.received.filter((file) => file.blob).length > 1 ? 'Download all (ZIP)' : 'Download'}
                    </button>
                    <span className="text-xs text-muted">
                      {record.received.length} {record.received.length === 1 ? 'file' : 'files'} ·{' '}
                      {formatBytes(record.received.reduce((sum, file) => sum + file.size, 0))}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {record.received.map((file) => (
                      <ReceivedFileRow key={file.id} file={file} />
                    ))}
                  </ul>
                </>
              )}
              {record.received.length === 0 && (
                <p className="text-xs text-muted">No files were saved for this transfer.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function TransferList() {
  const { transfers, clearFinished } = useLanShare();
  if (transfers.length === 0) return null;
  const hasFinished = transfers.some(
    (record) => record.status === 'completed' || record.status === 'cancelled' || record.status === 'failed' || record.status === 'rejected',
  );

  return (
    <section aria-labelledby="transfers-heading" className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 id="transfers-heading" className="text-sm font-semibold text-text">
          Transfers
        </h2>
        {hasFinished && (
          <button type="button" className="btn btn-ghost px-3 text-xs" onClick={clearFinished}>
            Clear finished
          </button>
        )}
      </div>
      <ul className="space-y-2.5">
        {transfers.map((record) => (
          <TransferRow key={record.id} record={record} />
        ))}
      </ul>
    </section>
  );
}
