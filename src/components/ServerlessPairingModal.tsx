import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Keyboard,
  Link2,
  Loader2,
  QrCode as QrIcon,
  ScanLine,
  Users,
} from 'lucide-react';
import { config } from '../config';
import { useLanShare } from '../state/lanshare';
import { useToast } from '../state/toast';
import { copyText } from '../utils/clipboard';
import { looksLikeManualPayload } from '../services/manualPairing';
import { Modal } from './Modal';
import { cn } from '../utils/cn';

type Mode = 'choose' | 'invite' | 'join';

/**
 * Serverless pairing — for when there is no signaling server at all: no Node on the computer,
 * two phones, no router, no internet. The two devices still need to reach each other (same
 * Wi-Fi or a phone hotspot); what they do *not* need is anything in the middle. The pairing
 * code is the offer/answer exchange, carried by the user: shown as a QR code and as text.
 */
export function ServerlessPairingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    createServerlessInvite,
    joinServerlessInvite,
    completeServerlessInvite,
    cancelServerlessInvite,
    peers,
  } = useLanShare();
  const toast = useToast();

  const [mode, setMode] = useState<Mode>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [invite, setInvite] = useState<{ handle: string; payload: string } | null>(null);
  const [invitePaired, setInvitePaired] = useState(false);
  const [answerInput, setAnswerInput] = useState('');

  const [pastedInvite, setPastedInvite] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [joinedPeerId, setJoinedPeerId] = useState<string | null>(null);

  const handleRef = useRef<string | null>(null);
  handleRef.current = invite?.handle ?? null;

  const reset = useCallback(
    (keepOpen = true) => {
      if (handleRef.current && !invitePaired) cancelServerlessInvite(handleRef.current);
      setMode('choose');
      setError(null);
      setBusy(false);
      setInvite(null);
      setInvitePaired(false);
      setAnswerInput('');
      setPastedInvite('');
      setAnswer(null);
      setJoinedPeerId(null);
      if (!keepOpen) onClose();
    },
    [cancelServerlessInvite, invitePaired, onClose],
  );

  // Closing the dialog must not leave a half-open peer connection behind.
  useEffect(() => {
    if (open) return;
    if (handleRef.current && !invitePaired) cancelServerlessInvite(handleRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const peerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const peer of peers) map.set(peer.id, peer.name);
    return map;
  }, [peers]);

  const startInvite = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createServerlessInvite();
      setInvite(created);
      setMode('invite');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The pairing code could not be created.');
    } finally {
      setBusy(false);
    }
  }, [createServerlessInvite]);

  const finishInvite = useCallback(async () => {
    if (!invite) return;
    setBusy(true);
    setError(null);
    try {
      await completeServerlessInvite(invite.handle, answerInput);
      setInvitePaired(true);
      toast.push({ variant: 'success', message: 'Connection established without a server' });
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'That reply code was not accepted.');
    } finally {
      setBusy(false);
    }
  }, [answerInput, completeServerlessInvite, invite, toast]);

  const acceptInvite = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { peerId, payload } = await joinServerlessInvite(pastedInvite);
      setAnswer(payload);
      setJoinedPeerId(peerId);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'That pairing code was not accepted.');
    } finally {
      setBusy(false);
    }
  }, [joinServerlessInvite, pastedInvite]);

  return (
    <Modal
      open={open}
      onClose={() => reset(false)}
      title="Pair without a server"
      description="No signaling server and no internet needed — both devices just have to reach each other."
      variant="sheet"
      size="lg"
    >
      <div className="space-y-4">
        {mode === 'choose' && (
          <>
            <p className="text-xs leading-relaxed text-muted">
              Use this when LANShare cannot discover the other device because there is no
              connection service available (no internet, no computer running the server, or the
              devices are on a phone hotspot). You move one short code between the devices —
              scan it or paste it — and the transfer then runs directly.
            </p>
            <div className="grid gap-2 xs:grid-cols-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void startInvite()}
                disabled={busy}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <QrIcon size={16} />}
                Create a pairing code
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setMode('join')}>
                <ScanLine size={16} />
                I have a code
              </button>
            </div>
            <ul className="space-y-1.5 text-xs leading-relaxed text-muted">
              <li>· The other device must be on the same Wi-Fi or hotspot as this one.</li>
              <li>· Nothing is uploaded: the code only carries connection details.</li>
              <li>· Pairing codes are single-use and stop working when this dialog closes.</li>
            </ul>
          </>
        )}

        {mode === 'invite' && invite && (
          <>
            {invitePaired ? (
              <PairedSummary peerName={peerNameById.get(peerNameById.keys().next().value ?? '') ?? 'The other device'} />
            ) : (
              <>
                <Step number={1} title="Show this code on the other device">
                  <PayloadBlock payload={invite.payload} toast={toast} label="Invite" />
                </Step>
                <Step number={2} title="Paste the reply code it gives you">
                  <textarea
                    className="input h-24 w-full resize-none font-mono text-[11px]"
                    placeholder="LS1.…"
                    value={answerInput}
                    onChange={(event) => setAnswerInput(event.target.value)}
                    aria-label="Reply code"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn-primary mt-2 w-full"
                    onClick={() => void finishInvite()}
                    disabled={busy || !looksLikeManualPayload(answerInput)}
                  >
                    {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                    Connect
                  </button>
                </Step>
              </>
            )}
          </>
        )}

        {mode === 'join' && (
          <>
            {answer ? (
              <Step number={2} title="Give this reply code back to the first device">
                <PayloadBlock payload={answer} toast={toast} label="Reply" />
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  The other device pastes it and both sides connect. Keep this dialog open until
                  the transfer finishes.
                </p>
              </Step>
            ) : (
              <Step number={1} title="Paste the pairing code from the other device">
                <textarea
                  className="input h-28 w-full resize-none font-mono text-[11px]"
                  placeholder="LS1.…"
                  value={pastedInvite}
                  onChange={(event) => setPastedInvite(event.target.value)}
                  aria-label="Pairing code"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-primary mt-2 w-full"
                  onClick={() => void acceptInvite()}
                  disabled={busy || !looksLikeManualPayload(pastedInvite)}
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  Create reply code
                </button>
              </Step>
            )}
          </>
        )}

        {error && (
          <p className="flex items-start gap-2 text-xs leading-relaxed text-[color:var(--danger)]" role="alert">
            <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}

        {joinedPeerId && (
          <p className="flex items-center gap-2 text-xs text-[color:var(--success)]">
            <Check size={14} aria-hidden="true" />
            {peerNameById.get(joinedPeerId) ?? 'The other device'} is connecting…
          </p>
        )}

        {mode !== 'choose' && (
          <button type="button" className="btn btn-secondary w-full" onClick={() => reset(true)}>
            <Keyboard size={15} />
            Start over
          </button>
        )}

        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
          <Link2 size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          The code is text, so it can travel any way you like: scan the QR with your phone's own
          camera app, paste it into a chat message to yourself, or type it in directly. LANShare
          never opens the camera — nothing here reads an image.
        </p>
      </div>
    </Modal>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="surface-muted space-y-2 p-3">
      <p className="flex items-center gap-2 text-xs font-semibold text-text">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[color:var(--accent-soft)] text-[11px] text-accent">
          {number}
        </span>
        {title}
      </p>
      {children}
    </section>
  );
}

/** The payload as a QR code (when it fits) plus the text and a copy button. */
function PayloadBlock({
  payload,
  toast,
  label,
}: {
  payload: string;
  toast: ReturnType<typeof useToast>;
  label: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const fits = payload.length <= config.manualPairing.maxQrPayloadChars;

  useEffect(() => {
    if (!fits) {
      setQrFailed(true);
      return;
    }
    let cancelled = false;
    setQrFailed(false);
    QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'L',
      margin: 1,
      width: 512,
      color: { dark: '#0e1626ff', light: '#ffffffff' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [payload, fits]);

  return (
    <div className="space-y-2">
      {!qrFailed && dataUrl ? (
        <div className="flex justify-center">
          <img
            src={dataUrl}
            width={196}
            height={196}
            alt={`${label} pairing code as a QR code`}
            className={cn('rounded-xl border border-border bg-white p-2')}
            style={{ width: 196, height: 196 }}
          />
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted">
          This code is too long to show as a QR image — use the text below.
        </p>
      )}
      <textarea
        className="input h-20 w-full resize-none font-mono text-[10px] leading-relaxed"
        value={payload}
        readOnly
        aria-label={`${label} pairing code`}
        onFocus={(event) => event.currentTarget.select()}
        spellCheck={false}
      />
      <button
        type="button"
        className="btn btn-secondary w-full text-xs"
        onClick={async () => {
          const ok = await copyText(payload);
          toast.push({ variant: ok ? 'success' : 'error', message: ok ? 'Pairing code copied' : 'Could not copy' });
        }}
      >
        <Copy size={14} />
        Copy code
      </button>
    </div>
  );
}

function PairedSummary({ peerName }: { peerName: string }) {
  return (
    <div className="surface-muted flex items-start gap-3 p-3">
      <Users size={18} className="mt-0.5 shrink-0 text-[color:var(--success)]" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-text">Paired with {peerName}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          There is no server involved in this connection. Close this dialog and pick the device in
          the list to send files.
        </p>
      </div>
    </div>
  );
}
