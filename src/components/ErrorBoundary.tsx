import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { APP_NAME } from '../config';
import { log } from '../services/logger';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps a rendering fault from blanking the whole app; offers a clean reload. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Message only — never log any transfer payload.
    log.error('Unhandled UI error', error.message, info.componentStack?.split('\n')[1] ?? '');
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-sm leading-relaxed text-muted">
          {APP_NAME} hit an unexpected error and stopped rendering. Your files are untouched — nothing is uploaded
          anywhere. Reload to continue.
        </p>
        <pre className="surface w-full overflow-auto p-3 text-left text-[11px] text-muted">
          {this.state.error.message}
        </pre>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          <RefreshCw size={16} />
          Reload {APP_NAME}
        </button>
      </main>
    );
  }
}
