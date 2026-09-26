import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_SETTINGS,
  applyTheme,
  loadSettings,
  saveSettings,
  watchSystemTheme,
  type SaveBehavior,
  type Settings,
  type ThemePreference,
} from '../services/storage';
import { getDeviceId, loadStoredName, storeName } from '../utils/randomName';
import type { DeviceKind } from '../types/protocol';

interface SettingsContextValue {
  settings: Settings;
  deviceId: string;
  deviceKind: DeviceKind;
  deviceLabel: string;
  /** Notifications permission state as reported by the browser. */
  notificationPermission: NotificationPermission | 'unsupported';
  update: (patch: Partial<Settings>) => void;
  setTheme: (theme: ThemePreference) => void;
  setDisplayName: (name: string) => void;
  setNotifications: (enabled: boolean) => Promise<boolean>;
  setSaveBehavior: (behavior: SaveBehavior) => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export interface SettingsProviderProps {
  children: ReactNode;
  deviceKind: DeviceKind;
  deviceLabel: string;
  initialName: string;
}

export function SettingsProvider({ children, deviceKind, deviceLabel, initialName }: SettingsProviderProps) {
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = loadSettings();
    const storedName = loadStoredName();
    return {
      ...loaded,
      displayName: loaded.displayName || storedName || initialName,
    };
  });
  const [deviceId] = useState(() => getDeviceId());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Apply theme immediately and on change.
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // Follow the OS when the user picked "System".
  useEffect(() => {
    if (settings.theme !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [settings.theme]);

  // Persist (debounced) whenever settings change.
  useEffect(() => {
    const timer = setTimeout(() => saveSettings(settings), 150);
    return () => clearTimeout(timer);
  }, [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const setTheme = useCallback((theme: ThemePreference) => update({ theme }), [update]);

  const setDisplayName = useCallback(
    (name: string) => {
      const clean = name.trim().slice(0, 32);
      if (!clean) return;
      storeName(clean);
      update({ displayName: clean });
    },
    [update],
  );

  const notificationPermission: NotificationPermission | 'unsupported' =
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  const setNotifications = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      if (!enabled) {
        update({ notifications: false });
        return true;
      }
      if (typeof Notification === 'undefined') return false;
      try {
        const permission =
          Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        if (permission === 'granted') {
          update({ notifications: true });
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
    [update],
  );

  const setSaveBehavior = useCallback((saveBehavior: SaveBehavior) => update({ saveBehavior }), [update]);
  const completeOnboarding = useCallback(() => update({ seenOnboarding: true }), [update]);
  const resetOnboarding = useCallback(() => update({ seenOnboarding: false }), [update]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      deviceId,
      deviceKind,
      deviceLabel,
      notificationPermission,
      update,
      setTheme,
      setDisplayName,
      setNotifications,
      setSaveBehavior,
      completeOnboarding,
      resetOnboarding,
    }),
    [
      settings,
      deviceId,
      deviceKind,
      deviceLabel,
      notificationPermission,
      update,
      setTheme,
      setDisplayName,
      setNotifications,
      setSaveBehavior,
      completeOnboarding,
      resetOnboarding,
    ],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error('useSettings must be used inside <SettingsProvider>');
  return context;
}

export { DEFAULT_SETTINGS };
