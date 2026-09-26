import { useEffect, useMemo, useRef } from 'react';
import { Send, X } from 'lucide-react';
import { config } from '../config';
import { firstUrl, linkifyText, urlHost } from '../utils/validation';

interface TextShareProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  canSend: boolean;
}

/** Free-form text / link / code sharing with URL detection (no auto-navigation). */
export function TextShare({ value, onChange, onSend, canSend }: TextShareProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const url = useMemo(() => firstUrl(value), [value]);
  const tooLong = value.length > config.maxTextLength;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'Enter' && canSend) {
        event.preventDefault();
        onSend();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canSend, onSend]);

  const preview = useMemo(() => (url ? linkifyText(value.slice(0, 400)) : []), [url, value]);

  return (
    <div className="surface flex flex-col gap-3 p-4 sm:p-5">
      <div>
        <label htmlFor="text-share-input" className="label">
          Text, link or code
        </label>
        <textarea
          id="text-share-input"
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={7}
          spellCheck={false}
          placeholder="Paste text, a URL, a code snippet or a note…"
          className="input scroll-area resize-y font-mono text-[13px] leading-relaxed"
          aria-describedby="text-share-help"
        />
      </div>

      {url && preview.length > 0 && (
        <div className="surface-muted flex flex-col gap-1 p-3 text-xs">
          <span className="font-semibold text-muted">🔗 Link detected</span>
          <span className="break-all font-mono text-text">{urlHost(url)}</span>
          <div className="mt-1 flex items-center gap-3">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="font-semibold text-accent underline-offset-2 hover:underline"
            >
              Open
            </a>
            <button
              type="button"
              className="font-semibold text-muted underline-offset-2 hover:underline"
              onClick={() => void navigator.clipboard?.writeText(url).catch(() => undefined)}
            >
              Copy
            </button>
            <span className="text-muted">Links are never opened automatically.</span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 xs:flex-row xs:items-center xs:justify-between">
        <p id="text-share-help" className="text-xs text-muted">
          {value.length.toLocaleString()} characters
          {tooLong && <span className="text-[color:var(--danger)]"> · too long to send</span>}
        </p>
        <div className="flex items-center gap-2">
          {value.length > 0 && (
            <button type="button" className="btn btn-ghost px-3" onClick={() => onChange('')} aria-label="Clear text">
              <X size={15} />
              Clear
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={onSend} disabled={!canSend || tooLong}>
            <Send size={16} />
            Send text
          </button>
        </div>
      </div>
    </div>
  );
}
