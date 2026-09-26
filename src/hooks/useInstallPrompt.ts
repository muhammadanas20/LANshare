import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Captures the `beforeinstallprompt` event so "Install app" can be offered at a
 * moment of the user's choosing instead of immediately.
 */
export function useInstallPrompt(): { canInstall: boolean; promptInstall: () => Promise<void> } {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (rawEvent: Event) => {
      rawEvent.preventDefault();
      setEvent(rawEvent as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    const installed = () => setEvent(null);
    window.addEventListener('appinstalled', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!event) return;
    try {
      await event.prompt();
      await event.userChoice;
    } finally {
      setEvent(null);
    }
  }, [event]);

  return { canInstall: Boolean(event), promptInstall };
}
