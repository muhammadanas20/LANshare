import { useEffect, useState } from 'react';

export interface NetworkStatus {
  online: boolean;
  /** Browser online state only — WebRTC reachability is tracked separately. */
  since: number;
}

const OFFLINE_EVENT = 'offline';
const ONLINE_EVENT = 'online';

/** Tracks `navigator.onLine` plus the browser's connectivity events (spec §36). */
export function useNetworkStatus(): NetworkStatus {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  const [since, setSince] = useState(() => Date.now());

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      setSince(Date.now());
    };
    const goOffline = () => {
      setOnline(false);
      setSince(Date.now());
    };
    window.addEventListener(ONLINE_EVENT, goOnline);
    window.addEventListener(OFFLINE_EVENT, goOffline);
    return () => {
      window.removeEventListener(ONLINE_EVENT, goOnline);
      window.removeEventListener(OFFLINE_EVENT, goOffline);
    };
  }, []);

  return { online, since };
}
