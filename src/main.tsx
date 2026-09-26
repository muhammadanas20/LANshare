import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './state/toast';
import { SettingsProvider } from './state/settings';
import { LanShareProvider } from './state/lanshare';
import { normalizeDisplayName } from './boot/identity';
import { detectDeviceKind, deviceKindLabel, deviceNameSuffix } from './utils/device';
import { defaultDisplayName } from './utils/randomName';
import { registerServiceWorker } from './pwa';

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

const deviceKind = detectDeviceKind();
const deviceLabel = deviceKindLabel(deviceKind);
const initialName = normalizeDisplayName(defaultDisplayName(deviceNameSuffix(deviceKind)));

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <SettingsProvider deviceKind={deviceKind} deviceLabel={deviceLabel} initialName={initialName}>
          <LanShareProvider>
            <App />
          </LanShareProvider>
        </SettingsProvider>
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);

registerServiceWorker();
