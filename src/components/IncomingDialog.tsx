import { Check, FileStack, Link2, MessageSquare, X } from 'lucide-react';
import { useLanShare } from '../state/lanshare';
import { formatBytes } from '../utils/format';
import { fileTypeLabel } from '../utils/fileKind';
import { Modal } from './Modal';
import { FileTypeIcon } from './FileTypeIcon';

/** Receiver approval dialog — nothing is written to disk or memory before consent. */
export function IncomingDialog() {
  const { incoming, acceptTransfer, rejectTransfer, receiveFolderName } = useLanShare();
  const request = incoming[0];
  if (!request) return null;

  const isText = request.kind === 'text';
  const fileCount = request.items.length;

  return (
    <Modal
      open
      onClose={() => rejectTransfer(request.id)}
      title="Incoming transfer"
      description={`${request.peerName} wants to send ${isText ? 'text' : fileCount === 1 ? 'a file' : `${fileCount} files`}`}
      variant="sheet"
      size="md"
      footer={
        <div className="flex flex-col gap-2 xs:flex-row xs:justify-end">
          <button type="button" className="btn btn-secondary xs:order-1" onClick={() => rejectTransfer(request.id)}>
            <X size={16} />
            Decline
          </button>
          <button type="button" className="btn btn-primary xs:order-2" onClick={() => acceptTransfer(request.id)}>
            <Check size={16} />
            {isText ? 'Accept' : fileCount === 1 ? 'Accept' : 'Accept all'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {isText ? (
          <div className="surface-muted p-3">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              <MessageSquare size={13} aria-hidden="true" />
              Text preview
            </p>
            <pre className="scroll-area max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text">
              {(request.text ?? '').slice(0, 1200)}
              {(request.text ?? '').length > 1200 ? '…' : ''}
            </pre>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-[color:var(--surface-secondary)]">
                <FileStack size={19} className="text-accent" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-medium text-text">
                  {formatBytes(request.totalSize)} total
                </p>
                <p className="text-xs text-muted">
                  {fileCount} {fileCount === 1 ? 'file' : 'files'} · expires in a few minutes without a decision
                </p>
              </div>
            </div>

            <ul className="scroll-area max-h-52 space-y-1.5 overflow-y-auto pr-0.5">
              {request.items.slice(0, 50).map((item) => (
                <li key={item.id} className="file-tile flex items-center gap-3 p-2.5">
                  <FileTypeIcon mime={item.mime} name={item.name} size={18} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-text" title={item.name}>
                      {item.name}
                    </p>
                    <p className="text-[11px] text-muted">
                      {fileTypeLabel(item.mime, item.name)} · {formatBytes(item.size)}
                    </p>
                  </div>
                </li>
              ))}
              {fileCount > 50 && (
                <li className="px-1 py-1 text-xs text-muted">…and {fileCount - 50} more</li>
              )}
            </ul>
          </>
        )}

        {receiveFolderName ? (
          <p className="flex items-start gap-2 text-xs text-muted">
            <Link2 size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            Files will be saved straight to “{receiveFolderName}” as they arrive.
          </p>
        ) : (
          <p className="text-xs text-muted">
            You will be able to save each file, or all of them as a ZIP archive, once the transfer completes.
          </p>
        )}
      </div>
    </Modal>
  );
}
