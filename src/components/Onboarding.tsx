import { ArrowRight, Laptop, ShieldCheck, Smartphone, Wifi } from 'lucide-react';
import { APP_NAME, CREATOR } from '../config';
import { Modal } from './Modal';
import { Logo } from './Logo';

/** First-run explainer. Shown once, until the user resets it from settings. */
export function Onboarding({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Welcome to ${APP_NAME}`}
      description="Peer-to-peer sharing between devices on the same network."
      variant="sheet"
      size="md"
      footer={
        <button type="button" className="btn btn-primary w-full" onClick={onClose}>
          Continue
          <ArrowRight size={16} />
        </button>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Logo size={44} />
          <div>
            <p className="text-sm font-semibold text-text">No account, no uploads</p>
            <p className="text-xs text-muted">Files travel directly between your devices.</p>
          </div>
        </div>

        <ol className="space-y-3">
          {[
            {
              icon: Smartphone,
              title: 'Open this page on the other device',
              detail: 'Both devices should be on the same Wi-Fi or local network.',
            },
            {
              icon: Wifi,
              title: 'Pick the device you see',
              detail: 'Nearby devices appear automatically — tap one, or scan the QR code to pair.',
            },
            {
              icon: Laptop,
              title: 'The receiver accepts, then it transfers',
              detail: 'Nothing is downloaded without consent, and you can cancel at any time.',
            },
          ].map(({ icon: Icon, title, detail }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-[color:var(--surface-secondary)]">
                <Icon size={15} className="text-accent" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-medium text-text">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">{detail}</span>
              </span>
            </li>
          ))}
        </ol>

        <p className="flex items-start gap-2 rounded-xl border border-border bg-[color:var(--surface-secondary)] p-3 text-xs leading-relaxed text-muted">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[color:var(--success)]" aria-hidden="true" />
          A connection service may help the devices find each other, but transferred file data is not stored there.
          Transfers use an encrypted WebRTC data channel.
        </p>

        <p className="text-center text-xs text-muted">
          Built by <span className="font-medium text-text">{CREATOR}</span>
        </p>
      </div>
    </Modal>
  );
}
