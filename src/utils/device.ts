import type { DeviceKind } from '../types/protocol';

/**
 * Coarse device classification only.
 * We intentionally avoid building or exposing a fingerprint — the label exists so
 * the UI can pick the right icon and the user can tell two of their own devices apart.
 */
export function detectDeviceKind(): DeviceKind {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  const touchPoints = navigator.maxTouchPoints ?? 0;
  const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  // iPadOS 13+ reports as "Macintosh" but has touch points.
  if (/Macintosh/i.test(ua) && touchPoints > 1) return 'tablet';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
  if (coarsePointer && window.innerWidth < 820) return 'mobile';
  if (typeof window !== 'undefined' && window.innerWidth > 0) return 'desktop';
  return 'unknown';
}

const KIND_LABELS: Record<DeviceKind, string> = {
  desktop: 'Computer',
  mobile: 'Phone',
  tablet: 'Tablet',
  unknown: 'Device',
};

export function deviceKindLabel(kind: DeviceKind): string {
  return KIND_LABELS[kind] ?? 'Device';
}

/** Short suffix appended to auto-generated names: "Blue Falcon (Phone)". */
export function deviceNameSuffix(kind: DeviceKind): string | undefined {
  if (kind === 'mobile') return 'Phone';
  if (kind === 'tablet') return 'Tablet';
  return undefined;
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export function supportsShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export function canShareFiles(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function'
  );
}

export interface CapabilityReport {
  ok: boolean;
  missing: string[];
}

/** Hard capability check before the app boots (spec §48). */
export function checkBrowserCapabilities(): CapabilityReport {
  const missing: string[] = [];
  if (typeof window === 'undefined') return { ok: true, missing };
  if (typeof window.RTCPeerConnection !== 'function') missing.push('WebRTC (RTCPeerConnection)');
  if (typeof window.WebSocket !== 'function') missing.push('WebSocket');
  if (typeof window.File !== 'function') missing.push('File API');
  if (typeof window.Blob !== 'function') missing.push('Blob API');
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    missing.push('Object URLs');
  }
  if (typeof window.crypto === 'undefined') missing.push('Web Crypto');
  return { ok: missing.length === 0, missing };
}

export function supportsReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
