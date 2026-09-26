/**
 * Signaling wire schemas (server side).
 *
 * Kept dependency-light but strict: a malformed or oversized message is rejected
 * before it can touch any server state.
 */
import { z } from 'zod';

export const DeviceKindSchema = z.enum(['desktop', 'mobile', 'tablet', 'unknown']);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const PeerNameSchema = z.string().trim().min(1).max(32);
export const RoomIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * SDP and ICE payloads only. `.strict()` is deliberate: a peer must not be able to
 * tunnel arbitrary extra data (for example base64 file bytes) to another peer through
 * the signaling server — unknown keys are rejected, not forwarded.
 */
export const SignalDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().min(1).max(32 * 1024) }).strict(),
  z.object({ kind: z.literal('answer'), sdp: z.string().min(1).max(32 * 1024) }).strict(),
  z
    .object({
      kind: z.literal('ice'),
      candidate: z
        .object({
          candidate: z.string().max(2048),
          sdpMid: z.string().max(64).nullable().optional(),
          sdpMLineIndex: z.number().int().min(0).max(128).nullable().optional(),
          usernameFragment: z.string().max(256).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type SignalData = z.infer<typeof SignalDataSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('HELLO'),
    name: PeerNameSchema,
    device: DeviceKindSchema.default('unknown'),
    room: RoomIdSchema.optional(),
    /** Random, non-identifying client key used to keep links alive across reconnects. */
    key: z.string().min(6).max(32).optional(),
  }),
  z.object({ type: z.literal('RENAME'), name: PeerNameSchema }),
  z.object({
    type: z.literal('SIGNAL'),
    to: z.string().min(1).max(64),
    data: SignalDataSchema,
  }),
  z.object({ type: z.literal('PING'), t: z.number().optional() }),
  z.object({ type: z.literal('LEAVE') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface PeerInfo {
  id: string;
  name: string;
  device: DeviceKind;
  joinedAt: number;
  /** Opaque, random, non-identifying client key (see HELLO). */
  key?: string;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ServerMessage =
  | {
      type: 'WELCOME';
      selfId: string;
      roomId: string;
      name: string;
      peers: PeerInfo[];
      iceServers?: IceServerConfig[];
      /** True when the host is running the offline LAN mode (no internet involved). */
      offline?: boolean;
      /** Join URLs of the host, so the UI can show "open this on your phone" + a QR code. */
      lan?: { urls: string[] };
      limits: { maxPeers: number; maxMessageBytes: number; serverTime: number };
      roomCreated: boolean;
    }
  | { type: 'PEER_LIST'; peers: PeerInfo[] }
  | { type: 'PEER_JOINED'; peer: PeerInfo }
  | { type: 'PEER_LEFT'; peerId: string }
  | { type: 'PEER_UPDATED'; peer: PeerInfo }
  | { type: 'SIGNAL'; from: string; data: SignalData }
  | { type: 'PONG'; t?: number }
  | { type: 'ERROR'; code: string; message: string; fatal?: boolean };

export const PROTOCOL_VERSION = '2';
