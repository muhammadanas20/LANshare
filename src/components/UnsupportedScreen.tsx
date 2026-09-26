import { AlertTriangle } from 'lucide-react';
import { APP_NAME } from '../config';

/** Shown instead of the app when the browser lacks required primitives (spec §48). */
export function UnsupportedScreen({ missing }: { missing: string[] }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertTriangle size={30} className="text-[color:var(--warning)]" aria-hidden="true" />
      <h1 className="text-xl font-semibold tracking-tight">Your browser cannot run {APP_NAME}</h1>
      <p className="text-sm leading-relaxed text-muted">
        {APP_NAME} needs WebRTC and a few modern browser APIs to move files directly between devices. Please use a recent
        version of Chrome, Firefox, Edge or Safari.
      </p>
      {missing.length > 0 && (
        <ul className="surface w-full space-y-1 p-3 text-left text-xs text-muted">
          {missing.map((item) => (
            <li key={item}>• Missing: {item}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Built by Muhammad Anas</p>
    </main>
  );
}
