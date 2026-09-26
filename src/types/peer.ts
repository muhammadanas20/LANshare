import type { DeviceKind } from './protocol';

export type { DeviceKind };

/** Reachability state of a discovered peer. */
export type PeerStatus =
  | 'available' // seen on the signaling server, no direct connection yet
  | 'connecting' // WebRTC negotiation / ICE in progress
  | 'connected' // data channel open
  | 'unstable' // connection degraded, ICE disconnected
  | 'failed' // negotiation failed (offered a retry)
  | 'offline'; // lost from signaling

export interface Peer {
  id: string;
  name: string;
  device: DeviceKind;
  joinedAt: number;
  status: PeerStatus;
  /** Best-effort RTT from data-channel PING/PONG, milliseconds. */
  rttMs?: number;
  /** Transport summary shown in the device details sheet (kept non-sensitive). */
  transport?: string;
}
